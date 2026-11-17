/**
 * SP-18 pending actions (rulings 3 and 4, Review Focus 2): the only place a
 * copilot write runs.
 *
 *  - propose(): the turn stores the card (PENDING, sealed {tool, args, card},
 *    ACTION_TTL_MS) and asks the approval policy; only a policy "apply" runs
 *    it at once (`decidedBy: "auto"`). Otherwise the card waits for the member.
 *  - approve(): the proposing member only (anyone else, even the owner: 404).
 *    At decision time, as the member: still a member (404), PENDING (409
 *    `copilot.action_closed {status}`), not expired (410), seal intact, the
 *    permission still held (403 `copilot.permission_revoked`), the record
 *    unchanged (409 `copilot.card_outdated`). Then one guarded
 *    PENDING → EXECUTING update decides it exactly once, and the write runs
 *    through the tool's existing service.
 *  - decline(): guarded PENDING → REJECTED with the member's note.
 *  Every transition is audited (no customer text) and a decision appends a
 *  note to the session; the next turn's context reports it to the model.
 */
import { ForbiddenException, HttpException, Inject, Injectable, Logger } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PermissionService } from "../permissions/permission.service";
import type { Viewer } from "../permissions/visibility";
import { ACTION_EXECUTING_STALE_MS, ACTION_TTL_MS, FEEDBACK_MAX, type ApprovalMode } from "./copilot-constants";
import { copilotError } from "./copilot-errors";
import { decideApproval, type PolicyDecision } from "./approval-policy";
import { sealAction, sealMatches } from "./args-hash";
import { cardDto, CopilotSessionsService } from "./copilot-sessions.service";
import type { PendingCardDto } from "./copilot.dto";
import { CardOutdated, CopilotToolRegistry, type CopilotTool, type ExecContext, type WriteProposal } from "./copilot-tools/registry";
import { COPILOT_REGISTRY } from "./copilot-registry.token";

type ActionRow = {
  id: string;
  workspaceId: string;
  sessionId: string;
  userId: string;
  tool: string;
  argsJson: unknown;
  argsHash: string;
  card: unknown;
  permission: string;
  status: string;
  decidedBy: string | null;
  decidedById: string | null;
  decidedAt: Date | null;
  feedback: string | null;
  refusal: string | null;
  resultJson: unknown;
  errorKey: string | null;
  expiresAt: Date;
  createdAt: Date;
};

export interface ProposeResult {
  action: PendingCardDto;
  policy: PolicyDecision;
}

const json = (v: unknown) => v as Prisma.InputJsonValue;

@Injectable()
export class CopilotActionsService {
  private readonly log = new Logger(CopilotActionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly perm: PermissionService,
    private readonly sessions: CopilotSessionsService,
    @Inject(COPILOT_REGISTRY) private readonly registry: CopilotToolRegistry,
  ) {}

  private async audit(a: Pick<ActionRow, "workspaceId" | "id" | "tool">, event: string, actorId: string | null, detail?: Record<string, unknown>) {
    await this.prisma.copilotActionAudit.create({
      data: { workspaceId: a.workspaceId, actionId: a.id, event, actorId, tool: a.tool, ...(detail ? { detail: json(detail) } : {}) },
    });
  }

  private async load(workspaceId: string, id: string): Promise<ActionRow> {
    return (await this.prisma.copilotPendingAction.findFirst({ where: { id, workspaceId } })) as ActionRow;
  }

  /** A note in the session for a decision (tool key and status only: no customer text). */
  private async note(a: ActionRow, text: string) {
    await this.sessions.append(a.workspaceId, a.sessionId, { role: "note", text }).catch(() => undefined);
  }

  /** Store the card; apply it at once only when the policy says so. Never throws for the turn. */
  async propose(
    p: { workspaceId: string; viewer: Viewer; sessionId: string; mode: ApprovalMode; tainted: boolean; now?: Date },
    tool: CopilotTool,
    proposal: WriteProposal,
  ): Promise<ProposeResult> {
    const now = p.now ?? new Date();
    const policy = decideApproval({ mode: p.mode, tool: tool.name, risk: proposal.risk, tainted: p.tainted });
    const row = (await this.prisma.copilotPendingAction.create({
      data: {
        workspaceId: p.workspaceId,
        sessionId: p.sessionId,
        userId: p.viewer.userId,
        tool: tool.name,
        argsJson: json(proposal.args),
        argsHash: sealAction(tool.name, proposal.args, proposal.card),
        card: json(proposal.card),
        permission: proposal.permission,
        status: "PENDING",
        expiresAt: new Date(now.getTime() + ACTION_TTL_MS),
      },
    })) as ActionRow;
    await this.audit(row, "PROPOSED", p.viewer.userId, { risk: proposal.risk, mode: p.mode, policy: policy.reason });
    if (!policy.apply) return { action: cardDto(row), policy };
    try {
      return { action: await this.run(row, p.viewer, "auto", now), policy };
    } catch {
      // Refused or failed at once: the row says why; the turn reports the status.
      return { action: cardDto(await this.load(p.workspaceId, row.id)), policy };
    }
  }

  /** The member's own action, with membership checked first (404 for anyone else). */
  private async own(workspaceId: string, viewer: Viewer, id: string): Promise<ActionRow> {
    if (!(await this.perm.effective(workspaceId, viewer.userId))) throw copilotError("copilot.not_found");
    const a = await this.prisma.copilotPendingAction.findFirst({ where: { id: String(id ?? ""), workspaceId, userId: viewer.userId } });
    if (!a) throw copilotError("copilot.not_found");
    return a as ActionRow;
  }

  /** PENDING and not expired, or the matching error (an expired card is marked EXPIRED once). */
  private async assertOpen(a: ActionRow, now: Date): Promise<void> {
    if (a.status !== "PENDING") throw copilotError("copilot.action_closed", { status: a.status });
    if (a.expiresAt.getTime() <= now.getTime()) {
      const r = await this.prisma.copilotPendingAction.updateMany({
        where: { id: a.id, workspaceId: a.workspaceId, status: "PENDING" },
        data: { status: "EXPIRED", decidedAt: now },
      });
      if (r.count === 1) await this.audit(a, "EXPIRED", null);
      throw copilotError("copilot.action_expired");
    }
  }

  /** PENDING → REJECTED with a refusal, audited and noted; then the HTTP error. */
  private async refuse(a: ActionRow, refusal: "permission_revoked" | "card_outdated", actorId: string, now: Date, from = "PENDING"): Promise<never> {
    const r = await this.prisma.copilotPendingAction.updateMany({
      where: { id: a.id, workspaceId: a.workspaceId, status: from },
      data: { status: "REJECTED", refusal, decidedById: actorId, decidedAt: now },
    });
    if (r.count !== 1) {
      const cur = await this.load(a.workspaceId, a.id);
      throw copilotError("copilot.action_closed", { status: cur?.status ?? a.status });
    }
    await this.audit(a, "REFUSED", actorId, { refusal });
    await this.note(a, `Not done (${refusal}): ${a.tool}`);
    throw refusal === "permission_revoked" ? copilotError("copilot.permission_revoked") : copilotError("copilot.card_outdated");
  }

  /**
   * Re-check as the member, take the action exactly once (guarded update),
   * run the write through the tool, record the result.
   */
  private async run(a: ActionRow, viewer: Viewer, decidedBy: "approved" | "auto", now: Date): Promise<PendingCardDto> {
    const tool = this.registry.get(a.tool);
    const exec: ExecContext = { workspaceId: a.workspaceId, viewer, sessionId: a.sessionId, now };
    const args = (a.argsJson ?? {}) as Record<string, unknown>;
    if (!tool || tool.kind !== "write" || !tool.apply || !tool.recheck) return this.refuse(a, "card_outdated", viewer.userId, now);
    if (!sealMatches(a)) return this.refuse(a, "card_outdated", viewer.userId, now);
    if (!(await this.perm.viewerCan(a.workspaceId, viewer, a.permission))) return this.refuse(a, "permission_revoked", viewer.userId, now);
    const check = await tool.recheck(exec, args);
    if (check !== "ok") return this.refuse(a, check, viewer.userId, now);

    const take = await this.prisma.copilotPendingAction.updateMany({
      where: { id: a.id, workspaceId: a.workspaceId, status: "PENDING" },
      data: { status: "EXECUTING", decidedBy, decidedById: viewer.userId, decidedAt: now },
    });
    if (take.count !== 1) {
      const cur = await this.load(a.workspaceId, a.id);
      throw copilotError("copilot.action_closed", { status: cur?.status ?? a.status });
    }
    // From here the row is EXECUTING: every failure must leave it FAILED (or,
    // when even that write fails, to resolveStale), never EXECUTING for good.
    let result: unknown;
    try {
      await this.audit(a, decidedBy === "auto" ? "AUTO_APPLIED" : "APPROVED", viewer.userId);
      result = await tool.apply(exec, args);
    } catch (e) {
      if (e instanceof CardOutdated) return this.refuse(a, "card_outdated", viewer.userId, now, "EXECUTING");
      if (e instanceof ForbiddenException) return this.refuse(a, "permission_revoked", viewer.userId, now, "EXECUTING");
      const errorKey = e instanceof HttpException ? String((e.getResponse() as { message?: unknown })?.message ?? e.message).slice(0, 120) : "copilot.action_failed";
      this.log.warn(`copilot action failed: ${a.tool}`);
      try {
        await this.prisma.copilotPendingAction.updateMany({ where: { id: a.id, workspaceId: a.workspaceId, status: "EXECUTING" }, data: { status: "FAILED", errorKey } });
        await this.audit(a, "FAILED", viewer.userId, { errorKey });
        if (decidedBy === "approved") await this.note(a, `Failed: ${a.tool}`);
      } catch {
        /* resolveStale marks it */
      }
      return cardDto(await this.load(a.workspaceId, a.id));
    }
    try {
      await this.prisma.copilotPendingAction.updateMany({
        where: { id: a.id, workspaceId: a.workspaceId, status: "EXECUTING" },
        data: { status: "EXECUTED", resultJson: json(result ?? null) },
      });
    } catch (e) {
      // The write happened but its status could not be stored: resolveStale
      // marks it "status unknown" after ACTION_EXECUTING_STALE_MS.
      this.log.warn(`copilot action result not stored: ${a.tool}`);
      throw e;
    }
    await this.audit(a, "EXECUTED", viewer.userId).catch(() => undefined);
    if (decidedBy === "approved") await this.note(a, `Approved and done: ${a.tool}`);
    return cardDto(await this.load(a.workspaceId, a.id));
  }

  /**
   * Cards left EXECUTING past ACTION_EXECUTING_STALE_MS (the process died
   * during the write, or its result could not be stored) become FAILED with
   * `errorKey: "copilot.action_unknown"`: the card says the outcome is
   * unknown and to check the record. Returns how many.
   */
  async resolveStale(now = new Date()): Promise<number> {
    const stale = (await this.prisma.copilotPendingAction.findMany({
      where: { status: "EXECUTING", decidedAt: { lt: new Date(now.getTime() - ACTION_EXECUTING_STALE_MS) } },
      take: 500,
    })) as ActionRow[];
    let n = 0;
    for (const a of stale) {
      const r = await this.prisma.copilotPendingAction.updateMany({
        where: { id: a.id, workspaceId: a.workspaceId, status: "EXECUTING" },
        data: { status: "FAILED", errorKey: "copilot.action_unknown" },
      });
      if (r.count !== 1) continue;
      n++;
      await this.audit(a, "FAILED", null, { errorKey: "copilot.action_unknown" }).catch(() => undefined);
      await this.note(a, `Status unknown: ${a.tool}`);
    }
    return n;
  }

  async approve(workspaceId: string, viewer: Viewer, id: string, now = new Date()): Promise<{ action: PendingCardDto }> {
    const a = await this.own(workspaceId, viewer, id);
    await this.assertOpen(a, now);
    return { action: await this.run(a, viewer, "approved", now) };
  }

  async decline(workspaceId: string, viewer: Viewer, id: string, note?: unknown, now = new Date()): Promise<{ action: PendingCardDto }> {
    const feedback = typeof note === "string" && note.trim() ? note.trim() : null;
    if (feedback && feedback.length > FEEDBACK_MAX) throw copilotError("copilot.feedback_too_long", { max: FEEDBACK_MAX });
    const a = await this.own(workspaceId, viewer, id);
    await this.assertOpen(a, now);
    const r = await this.prisma.copilotPendingAction.updateMany({
      where: { id: a.id, workspaceId, status: "PENDING" },
      data: { status: "REJECTED", refusal: "declined", feedback, decidedById: viewer.userId, decidedAt: now },
    });
    if (r.count !== 1) {
      const cur = await this.load(workspaceId, a.id);
      throw copilotError("copilot.action_closed", { status: cur?.status ?? a.status });
    }
    await this.audit(a, "REJECTED", viewer.userId, { hasNote: !!feedback });
    await this.note(a, `Declined: ${a.tool}`);
    return { action: cardDto(await this.load(workspaceId, a.id)) };
  }

  /**
   * Decisions the member took on this session's cards since `since` (not the
   * policy's own): for the next turn's context. Ids, tools and statuses only;
   * the member's decline notes separately (their own words).
   */
  async decisionsSince(workspaceId: string, sessionId: string, since: Date) {
    const rows = (await this.prisma.copilotPendingAction.findMany({
      where: { workspaceId, sessionId, decidedAt: { gte: since }, OR: [{ decidedBy: null }, { decidedBy: "approved" }] },
      orderBy: [{ decidedAt: "asc" }, { id: "asc" }],
    })) as ActionRow[];
    return rows.map((a) => ({ id: a.id, tool: a.tool, status: a.status, refusal: a.refusal, feedback: a.feedback }));
  }
}
