import {
  BadRequestException,
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { getWorkspaceContext } from '../common/workspace-context';
import { ADS_PROVIDER, type AdsProviderPort } from './ads-provider.port';
import { hashAction } from './ads-args-hash';
import { redactPii, redactArgsForTool, scrubText } from './ads-redact';

export interface PendingProposalInput {
  actionId: string;
  createdById: string;
  sessionId: string | null;
  tool: string;
  args: Record<string, unknown>;
  argsHash: string;
  summary: string;
  summaryIsPlaceholder: boolean;
}

export interface ApproveResult {
  status: 'executed' | 'already_executed';
  actionId: string;
  tool: string;
  summary: string;
  sessionId: string | null;
  result: unknown;
}

export interface RejectResult {
  status: 'rejected' | 'already_rejected';
  actionId: string;
  tool: string;
  sessionId: string | null;
}

// Sentinel: a status-guarded updateMany matched 0 rows inside a transaction —
// someone else already claimed/changed the row. Rolls the tx back.
class ClaimLost extends Error {}

// The workspace-scoped audit delegate — the type of auditCreate's `client` param.
// The plain scoped PrismaService is passed for best-effort audits; a $transaction
// `tx` is passed for transactional ones. The tx is `any` (see auditCreate — the
// $extends transaction-client type does not expose model delegates), but typing
// `client` off the REAL PrismaService delegate keeps the audit `.create` inside
// auditCreate compiler-checked no matter what the caller passes.
type ScopedClient = Pick<PrismaService, 'adsActionAudit'>;

// Every AdsActionAudit column, typed. This is the input to the ONE audit-write
// helper; optional fields are omitted from the row when unset. A real interface (not
// an inline literal at each call site) means a schema rename surfaces as a mismatch
// at the single create in auditCreate(), caught by the compiler.
interface AuditRow {
  actionId: string;
  event: 'PROPOSED' | 'APPROVED' | 'EXECUTED' | 'FAILED' | 'REJECTED' | 'EXPIRED';
  actorId: string | null;
  tool: string;
  sessionId: string | null;
  argsRedactedJson?: unknown;
  summary?: string | null;
  resultRedactedJson?: unknown;
  errorText?: string | null;
}

// ── THE ONE WRITE-EXECUTION PRIMITIVE ───────────────────────────────────────
// Module-private BY DESIGN: not exported from this file or any barrel, and not a
// class member — so no other module can import or call it. `import { executeGatedTool }`
// from anywhere is a COMPILE ERROR, not a code-review catch. Combined with
// AdsPendingActionService NOT being in AdsModule.exports (no cross-module inject)
// and ADS_PROVIDER no longer exported (no cross-module provider access), the only
// way a gated tool reaches Pipeboard is through approveAndExecute below — its sole
// caller — which has ALREADY verified owner authority, re-read state, checked the
// {tool,args} hash, refused placeholder summaries, enforced expiry, and atomically
// claimed the row. This function assumes all of that and just performs the call.
async function executeGatedTool(
  provider: AdsProviderPort,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return provider.callRaw(tool, args);
}

/**
 * The pending-action store and — in approveAndExecute — the ONLY code in the whole
 * system that executes a gated (write/consequential) Pipeboard tool. Everything
 * defensive lives here because this is the single line between an approval click
 * and a real change on Meta:
 *   • workspace-scoped load (cross-workspace action_id → NotFound)
 *   • the approver is the authenticated user passed by the endpoint; this service
 *     performs NO role check itself — approve/reject/topup are guarded upstream in
 *     ads.controller.ts by @UseGuards(WorkspaceRolesGuard) + @WorkspaceRoles('owner',
 *     'admin'), so any new endpoint that reaches approveAndExecute MUST carry the
 *     same guard. NO body/model-supplied "approved" flag is read anywhere
 *   • {tool,args} re-hashed and compared to the frozen argsHash (tamper/swap check)
 *   • un-rendered (placeholder) summaries are refused
 *   • expiry enforced lazily at approve/reject time (and re-guarded in the claim)
 *   • atomic PENDING→EXECUTING claim, transactional with the APPROVED audit row →
 *     executes at most once AND never leaves an approved-but-unaudited transition
 *   • state is re-read from the store; nothing is trusted from the caller but the id
 *   • APPEND-ONLY AdsActionAudit at every transition. PROPOSED/APPROVED/REJECTED/
 *     EXPIRED are TRANSACTIONAL with their status change (no unaudited transition).
 *     EXECUTED/FAILED are best-effort — the external write already happened, so an
 *     audit failure there can't abort it; it logs a loud AUDIT GAP and the action
 *     row still records the outcome (dual record, reconcilable).
 */
@Injectable()
export class AdsPendingActionService {
  private readonly log = new Logger(AdsPendingActionService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ADS_PROVIDER) private readonly provider: AdsProviderPort,
  ) {}

  private ttlMs(): number {
    const min = Number(process.env.ADS_ACTION_TTL_MIN ?? '15');
    return (Number.isFinite(min) && min > 0 ? min : 15) * 60_000;
  }

  // ── THE ONE TYPED AUDIT-WRITE PATH ────────────────────────────────────────
  // EVERY AdsActionAudit row goes through here: transactional events
  // (PROPOSED/APPROVED/REJECTED/EXPIRED) pass their $transaction `tx`; best-effort
  // events (EXECUTED/FAILED) pass the plain scoped client. `client` is typed off the
  // REAL PrismaService delegate (NOT `any`), so `client.adsActionAudit.create` below is
  // COMPILER-CHECKED at this single definition — a renamed/removed audit column is a
  // build error, not a field that silently stops recording. This row answers "who
  // approved spending money, and when"; its shape must be machine-verified.
  //
  // Why callers still pass an `any` tx: the $extends transaction-client type is
  // Omit<DynamicClientExtensionThis<…>, ITXClientDenyList> and does NOT expose model
  // delegates — `tx.adsActionAudit` is itself a type error — so `tx` cannot be given a
  // model-aware type here (a real Prisma limitation, reported not worked-around).
  // Routing the create through this full-client-typed param recovers the check: the
  // create STATEMENT is verified even though the tx handle can't be.
  //
  // workspaceId is REQUIRED by the generated AdsActionAuditUncheckedCreateInput. The
  // workspace-scope extension also injects it at runtime (create-op injection — plain
  // client AND inside a transaction); passing the SAME ctx value here keeps the row
  // checked instead of casting it to `any`. No workspace
  // context → throw: a transactional caller rolls back (no unaudited transition), and
  // auditBestEffort's catch turns it into a logged AUDIT GAP.
  private auditCreate(client: ScopedClient, row: AuditRow) {
    const workspaceId = getWorkspaceContext()?.workspaceId;
    if (!workspaceId) throw new Error('auditCreate: no workspace context');
    return client.adsActionAudit.create({
      data: {
        workspaceId,
        actionId: row.actionId,
        event: row.event,
        actorId: row.actorId,
        tool: row.tool,
        sessionId: row.sessionId,
        argsRedactedJson: row.argsRedactedJson === undefined ? undefined : (row.argsRedactedJson as Prisma.InputJsonValue),
        summary: row.summary ?? undefined,
        resultRedactedJson: row.resultRedactedJson === undefined ? undefined : (row.resultRedactedJson as Prisma.InputJsonValue),
        errorText: row.errorText ?? undefined,
      },
    });
  }

  /** Persist a gated proposal minted by the gate, ATOMICALLY with its PROPOSED
   *  audit row. The audit copy of the args is tool-aware-redacted; the operational
   *  argsJson keeps the RAW args (execution needs them; argsHash binds them). */
  async propose(p: PendingProposalInput): Promise<void> {
    await this.prisma.$transaction(async (tx: any) => {
      await tx.adsPendingAction.create({
        data: {
          id: p.actionId,
          createdById: p.createdById,
          sessionId: p.sessionId,
          tool: p.tool,
          argsJson: p.args as any,
          argsHash: p.argsHash,
          summary: p.summary, // already redacted by the gate
          summaryIsPlaceholder: p.summaryIsPlaceholder,
          status: 'PENDING',
          expiresAt: new Date(Date.now() + this.ttlMs()),
        },
      });
      await this.auditCreate(tx, {
        actionId: p.actionId,
        event: 'PROPOSED',
        actorId: p.createdById, // the model proposed inside this user's session
        tool: p.tool,
        sessionId: p.sessionId,
        argsRedactedJson: redactArgsForTool(p.tool, p.args),
        summary: p.summary,
      });
    });
  }

  // Best-effort audit for post-EXTERNAL-EFFECT events (EXECUTED/FAILED): the write
  // already happened, so an audit failure can't abort it — it logs a loud,
  // reconcilable AUDIT GAP instead (the action row still carries status/result).
  private async auditBestEffort(row: {
    actionId: string;
    event: 'EXECUTED' | 'FAILED';
    actorId: string | null;
    tool: string;
    sessionId: string | null;
    resultRedactedJson?: unknown;
    errorText?: string;
  }): Promise<void> {
    // Post-EXTERNAL-EFFECT (EXECUTED/FAILED): the write already happened, so an audit
    // failure — a DB error OR a missing workspace context (auditCreate throws) — can't
    // abort it. Same typed auditCreate as the transactional events, just wrapped so a
    // failure logs a loud, reconcilable AUDIT GAP instead of propagating.
    try {
      await this.auditCreate(this.prisma, row);
    } catch (e) {
      this.log.error(
        `AUDIT GAP: action ${row.actionId} transitioned to ${row.event} but the audit row failed: ${String(e)}`,
      );
    }
  }

  // Lazy expiry: mark a past-TTL PENDING row EXPIRED and audit it in ONE
  // transaction (no external side effect → the transition can and must be audited
  // atomically), then refuse.
  private async expireNow(row: { id: string; tool: string; sessionId: string | null }): Promise<never> {
    await this.prisma.$transaction(async (tx: any) => {
      const res = await tx.adsPendingAction.updateMany({
        where: { id: row.id, status: 'PENDING' },
        data: { status: 'EXPIRED' },
      });
      if (res.count > 0) {
        await this.auditCreate(tx, { actionId: row.id, event: 'EXPIRED', actorId: null, tool: row.tool, sessionId: row.sessionId });
      }
    });
    throw new GoneException('Ads action has expired; propose it again');
  }

  /**
   * Approve + execute one pending action. `approverId` is the authenticated
   * ads.view user from the endpoint — the accountability anchor — and the ONLY
   * caller-supplied value trusted besides `actionId`. There is no `approved`
   * parameter by design: approval IS the authenticated POST to the endpoint
   * (access IS authority — the ads-screen permission IS the approval permission).
   */
  async approveAndExecute(actionId: string, approverId: string): Promise<ApproveResult> {
    const db = this.prisma;
    const now = new Date();

    // Authority is enforced at the HTTP layer, not here: ads.controller.ts guards
    // the approve/reject/topup routes with @UseGuards(WorkspaceRolesGuard) +
    // @WorkspaceRoles('owner','admin'), so only an owner/admin request ever reaches
    // this method. This service does NOT re-check the role itself — it trusts the
    // guard already ran. Defense in depth here is additionally STRUCTURAL:
    // executeGatedTool is unimportable and this service is not cross-module
    // injectable, so a gated write can only be reached through this method, behind
    // that same HTTP guard. Any new endpoint wired to approveAndExecute MUST carry
    // the identical @WorkspaceRoles('owner','admin') guard.

    // Re-read state from the store — trust nothing from the request but the id.
    // workspace-scoped: a cross-workspace id reads back null → NotFound (no leak).
    const row = await db.adsPendingAction.findFirst({ where: { id: actionId } });
    if (!row) throw new NotFoundException('Ads action not found');

    // Idempotent: a repeat approve of an executed action returns the same result,
    // never a second execution.
    if (row.status === 'EXECUTED') {
      return { status: 'already_executed', actionId, tool: row.tool, summary: row.summary, sessionId: row.sessionId, result: row.resultJson };
    }
    if (row.status === 'EXECUTING') throw new ConflictException('Ads action is already being processed');
    if (row.status === 'FAILED') throw new ConflictException('Ads action already failed; propose it again');
    if (row.status === 'REJECTED') throw new ConflictException('Ads action was rejected');
    if (row.status === 'EXPIRED') throw new GoneException('Ads action has expired; propose it again');

    // PENDING but past its TTL → expire (+audit) now, refuse.
    if (row.expiresAt <= now) await this.expireNow(row);

    // Never approve an action whose summary was never machine-rendered — the owner
    // would be consenting to a tool name, not an understood change (STEP 5 flips
    // summaryIsPlaceholder to false only for renderer-generated summaries).
    if (row.summaryIsPlaceholder) {
      throw new BadRequestException('Ads action summary is not rendered yet; cannot be approved');
    }

    // Tamper/swap check: the stored {tool, args} must still hash to the frozen
    // argsHash — approval binds to the EXACT tool + args, not to an id whose
    // payload or tool could be swapped in the store.
    if (hashAction(row.tool, row.argsJson, row.summary) !== row.argsHash) {
      this.log.error(`ads action ${actionId}: action hash mismatch — refusing to execute (tampered store row)`);
      throw new BadRequestException('Ads action failed its integrity check');
    }

    // Atomic claim + APPROVED audit in ONE transaction: only the request that flips
    // PENDING→EXECUTING proceeds, and it cannot leave an approved-but-unaudited row
    // even across a crash — both commit or neither. The claim WHERE re-guards
    // expiry so a row crossing its TTL between the check above and here is refused.
    try {
      await db.$transaction(async (tx: any) => {
        const c = await tx.adsPendingAction.updateMany({
          where: { id: actionId, status: 'PENDING', expiresAt: { gt: now } },
          data: { status: 'EXECUTING', approvedById: approverId, approvedAt: now },
        });
        if (c.count === 0) throw new ClaimLost();
        await this.auditCreate(tx, { actionId, event: 'APPROVED', actorId: approverId, tool: row.tool, sessionId: row.sessionId });
      });
    } catch (e) {
      if (e instanceof ClaimLost) {
        const fresh = await db.adsPendingAction.findFirst({ where: { id: actionId } });
        if (fresh?.status === 'EXECUTED') {
          return { status: 'already_executed', actionId, tool: fresh.tool, summary: fresh.summary, sessionId: fresh.sessionId, result: fresh.resultJson };
        }
        throw new ConflictException('Ads action is already being processed or has expired');
      }
      this.log.error(`ads action ${actionId}: claim/APPROVED-audit tx failed — nothing executed: ${String(e)}`);
      throw new ServiceUnavailableException('Could not record the approval; nothing was executed');
    }

    // ── THE ONLY WRITE-EXECUTION LINE IN THE SYSTEM ─────────────────────────
    try {
      const result = await executeGatedTool(this.provider, row.tool, row.argsJson as Record<string, unknown>);
      // Store the REDACTED result on the operational row (durable; kept only for
      // idempotent already_executed replay). The RAW result is returned in-band to
      // the approver on THIS call and never persisted, so gated PII-exporting reads
      // (get_leads) don't accumulate raw customer data in the table.
      await db.adsPendingAction.updateMany({
        where: { id: actionId, status: 'EXECUTING' },
        data: { status: 'EXECUTED', executedAt: new Date(), resultJson: redactPii(result) as any },
      });
      await this.auditBestEffort({
        actionId, event: 'EXECUTED', actorId: approverId, tool: row.tool, sessionId: row.sessionId,
        resultRedactedJson: redactPii(result),
      });
      this.log.log(`ads action ${actionId} (${row.tool}) executed by ${approverId} (workspace ${getWorkspaceContext()?.workspaceId ?? 'unknown'})`);
      return { status: 'executed', actionId, tool: row.tool, summary: row.summary, sessionId: row.sessionId, result };
    } catch (e: any) {
      // Failed write → FAILED (not back to PENDING): a fresh proposal is required,
      // so an ambiguous partial failure is never silently retried. errorText is
      // value-scrubbed — provider errors routinely echo the offending phone/email.
      const errorText = scrubText(String(e?.message ?? e)).slice(0, 500);
      await db.adsPendingAction.updateMany({
        where: { id: actionId, status: 'EXECUTING' },
        data: { status: 'FAILED', errorText },
      });
      await this.auditBestEffort({
        actionId, event: 'FAILED', actorId: approverId, tool: row.tool, sessionId: row.sessionId, errorText,
      });
      this.log.error(`ads action ${actionId} (${row.tool}) execution failed`);
      throw e;
    }
  }

  /** Reject a pending action. Status flip + REJECTED audit are transactional (no
   *  external side effect → must be audited atomically). Idempotent. */
  async reject(actionId: string, rejectorId: string): Promise<RejectResult> {
    const db = this.prisma;

    const row = await db.adsPendingAction.findFirst({ where: { id: actionId } });
    if (!row) throw new NotFoundException('Ads action not found');

    if (row.status === 'REJECTED') return { status: 'already_rejected', actionId, tool: row.tool, sessionId: row.sessionId };
    if (row.status === 'EXECUTED' || row.status === 'EXECUTING') {
      throw new ConflictException('Ads action was already executed or is being processed');
    }
    if (row.status === 'FAILED') throw new ConflictException('Ads action already failed');
    if (row.status === 'EXPIRED') throw new GoneException('Ads action has expired');
    if (row.expiresAt <= new Date()) await this.expireNow(row);

    try {
      await db.$transaction(async (tx: any) => {
        const c = await tx.adsPendingAction.updateMany({
          where: { id: actionId, status: 'PENDING' },
          data: { status: 'REJECTED' },
        });
        if (c.count === 0) throw new ClaimLost();
        await this.auditCreate(tx, { actionId, event: 'REJECTED', actorId: rejectorId, tool: row.tool, sessionId: row.sessionId });
      });
    } catch (e) {
      if (e instanceof ClaimLost) throw new ConflictException('Ads action state changed; reload and retry');
      throw e;
    }
    return { status: 'rejected', actionId, tool: row.tool, sessionId: row.sessionId };
  }

  /** Read the still-actionable proposals for a session — PENDING and not past TTL —
   *  so the web can render/re-render approval cards (live turn AND reload). Called
   *  ONLY after the caller has verified session ownership (getSession, or the just-
   *  created session in postMessage); workspace scope + the sessionId filter are the
   *  isolation. Expired-but-PENDING rows (lazy expiry) are excluded by expiresAt, so
   *  the card never offers an action the approve endpoint would 410. */
  async listPendingForSession(sessionId: string) {
    return this.prisma.adsPendingAction.findMany({
      where: { sessionId, status: 'PENDING', expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'asc' },
    });
  }
}
