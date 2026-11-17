/**
 * SP-18 sessions and history (Review Focus 3). Every read and write is keyed
 * on (workspace, member): another member's session, even for an owner, and
 * another workspace's id are 404 `copilot.not_found`; a deleted session is
 * gone from lists and 404. Paging is a keyset on (updatedAt, id), stable
 * while rows change.
 *
 * The model transcript: each message row keeps in `content` the API messages
 * it contributes (a user turn: the user message and its context system
 * message; an assistant turn: assistant and tool_result messages, in order).
 * The replay is append-only, so the prompt cache and preserved thinking keep
 * working. Beyond TRANSCRIPT_TURNS_SENT turns only the last ones are sent,
 * after a one-line note, and then thinking blocks are stripped from the
 * replay (none is replayed out of the prefix it was bound to; ruling 8).
 *
 * A turn that never finished (the process died between the user row and the
 * closing assistant/note row) is closed in the replay, so one crash cannot
 * make every later turn of the session invalid; taking over an expired lease
 * also stores a closing note for the turn it abandons.
 */
import { Injectable } from "@nestjs/common";
import type Anthropic from "@anthropic-ai/sdk";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { HISTORY_PAGE, TRANSCRIPT_TURNS_SENT, TURN_BUDGET_MS } from "./copilot-constants";
import { copilotError } from "./copilot-errors";
import type { CopilotSessionDetailDto, CopilotSessionDto, CopilotSessionPage, PendingCardDto } from "./copilot.dto";
import { closeTranscript, NO_ANSWER, withoutThinking } from "./copilot-model";

/** The lease covers the whole turn plus a margin; an expired lease is free again. */
export const TURN_LEASE_MS = TURN_BUDGET_MS + 60_000;
export const EARLIER_NOTE = "Earlier messages are in the chat history; they are not repeated here.";

type SessionRow = { id: string; title: string | null; updatedAt: Date; runningUntil: Date | null; tainted: boolean };

const running = (s: { runningUntil: Date | null }, now: Date) => !!s.runningUntil && s.runningUntil.getTime() > now.getTime();

function encodeCursor(s: { updatedAt: Date; id: string }): string {
  return Buffer.from(`${s.updatedAt.toISOString()}|${s.id}`).toString("base64url");
}
function decodeCursor(c: string | undefined): { at: Date; id: string } | null {
  if (!c) return null;
  try {
    const [at, id] = Buffer.from(c, "base64url").toString("utf8").split("|");
    const d = new Date(at);
    return id && Number.isFinite(d.getTime()) ? { at: d, id } : null;
  } catch {
    return null;
  }
}

export function cardDto(a: {
  id: string;
  tool: string;
  card: unknown;
  status: string;
  expiresAt: Date;
  refusal: string | null;
  feedback: string | null;
  resultJson?: unknown;
}): PendingCardDto {
  const card = (a.card ?? {}) as { title?: string; changes?: PendingCardDto["changes"] };
  return {
    id: a.id,
    tool: a.tool,
    title: card.title ?? a.tool,
    changes: Array.isArray(card.changes) ? card.changes : [],
    status: a.status,
    expiresAt: a.expiresAt.toISOString(),
    refusal: a.refusal,
    feedback: a.feedback,
    ...(a.resultJson !== undefined && a.resultJson !== null ? { result: a.resultJson } : {}),
  };
}

@Injectable()
export class CopilotSessionsService {
  constructor(private readonly prisma: PrismaService) {}

  private dto(s: SessionRow, now: Date): CopilotSessionDto {
    return { id: s.id, title: s.title, updatedAt: s.updatedAt.toISOString(), running: running(s, now) };
  }

  async list(workspaceId: string, userId: string, cursor?: string, now = new Date()): Promise<CopilotSessionPage> {
    const c = decodeCursor(cursor);
    const rows = await this.prisma.copilotSession.findMany({
      where: {
        workspaceId,
        userId,
        deletedAt: null,
        ...(c ? { OR: [{ updatedAt: { lt: c.at } }, { updatedAt: c.at, id: { lt: c.id } }] } : {}),
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: HISTORY_PAGE + 1,
      select: { id: true, title: true, updatedAt: true, runningUntil: true, tainted: true },
    });
    const page = rows.slice(0, HISTORY_PAGE);
    return { items: page.map((s) => this.dto(s, now)), nextCursor: rows.length > HISTORY_PAGE ? encodeCursor(page[page.length - 1]) : null };
  }

  /** The member's own, not deleted; anything else is 404. */
  async own(workspaceId: string, userId: string, id: string) {
    const s = await this.prisma.copilotSession.findFirst({ where: { id: String(id ?? ""), workspaceId, userId, deletedAt: null } });
    if (!s) throw copilotError("copilot.not_found");
    return s;
  }

  async detail(workspaceId: string, userId: string, id: string, now = new Date()): Promise<CopilotSessionDetailDto> {
    const s = await this.own(workspaceId, userId, id);
    const [messages, actions] = await Promise.all([
      this.prisma.copilotMessage.findMany({
        where: { sessionId: s.id, workspaceId, role: { in: ["user", "assistant", "note"] } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, role: true, text: true, references: true, attachments: true, sources: true, createdAt: true },
      }),
      this.prisma.copilotPendingAction.findMany({ where: { sessionId: s.id, workspaceId, userId }, orderBy: { createdAt: "asc" } }),
    ]);
    return {
      id: s.id,
      title: s.title,
      running: running(s, now),
      tainted: s.tainted,
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        text: m.text,
        references: m.references ?? null,
        attachments: m.attachments ?? null,
        sources: m.sources ?? null,
        createdAt: m.createdAt.toISOString(),
      })),
      // A card past its TTL reads as EXPIRED (it is marked so when acted on).
      actions: actions.map((a) => cardDto(a.status === "PENDING" && a.expiresAt.getTime() <= now.getTime() ? { ...a, status: "EXPIRED" } : a)),
    };
  }

  async remove(workspaceId: string, userId: string, id: string, now = new Date()): Promise<{ ok: true }> {
    const s = await this.own(workspaceId, userId, id);
    await this.prisma.copilotSession.updateMany({ where: { id: s.id, workspaceId, userId }, data: { deletedAt: now } });
    return { ok: true };
  }

  async create(workspaceId: string, userId: string) {
    return this.prisma.copilotSession.create({ data: { workspaceId, userId } });
  }

  /**
   * Take the turn lease: 409 `copilot.turn_running` while another turn holds
   * it. Taking over an EXPIRED lease (the turn's process died) closes that
   * turn with a note, so its unanswered user message gets an answer.
   */
  async acquireTurn(workspaceId: string, userId: string, id: string, now = new Date()): Promise<void> {
    const free = await this.prisma.copilotSession.updateMany({
      where: { id, workspaceId, userId, deletedAt: null, runningUntil: null },
      data: { runningUntil: new Date(now.getTime() + TURN_LEASE_MS) },
    });
    if (free.count === 1) return;
    const expired = await this.prisma.copilotSession.updateMany({
      where: { id, workspaceId, userId, deletedAt: null, runningUntil: { lt: now } },
      data: { runningUntil: new Date(now.getTime() + TURN_LEASE_MS) },
    });
    if (expired.count === 1) {
      await this.closeAbandoned(workspaceId, id);
      return;
    }
    await this.own(workspaceId, userId, id); // 404 when not the member's
    throw copilotError("copilot.turn_running");
  }

  /** The abandoned turn's closing note, when its last row is still the user's. */
  private async closeAbandoned(workspaceId: string, sessionId: string): Promise<void> {
    const last = await this.prisma.copilotMessage.findFirst({
      where: { sessionId, workspaceId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { role: true },
    });
    if (last?.role !== "user") return;
    await this.append(workspaceId, sessionId, {
      role: "note",
      text: "copilot.timeout",
      content: [{ role: "assistant", content: [{ type: "text", text: NO_ANSWER }] }],
    });
  }

  async releaseTurn(workspaceId: string, id: string): Promise<void> {
    await this.prisma.copilotSession.updateMany({ where: { id, workspaceId }, data: { runningUntil: null } });
  }

  async markTainted(workspaceId: string, id: string): Promise<void> {
    await this.prisma.copilotSession.updateMany({ where: { id, workspaceId, tainted: false }, data: { tainted: true } });
  }

  async setTitle(workspaceId: string, id: string, title: string): Promise<void> {
    await this.prisma.copilotSession.updateMany({ where: { id, workspaceId, title: null }, data: { title } });
  }

  async append(
    workspaceId: string,
    sessionId: string,
    data: {
      role: "user" | "assistant" | "note";
      text: string;
      content?: Anthropic.Beta.BetaMessageParam[] | null;
      references?: unknown;
      attachments?: unknown;
      sources?: unknown;
      pageContext?: unknown;
      usage?: unknown;
    },
  ) {
    const json = (v: unknown) => (v === undefined || v === null ? undefined : (v as Prisma.InputJsonValue));
    // Strictly after the session's last message (ms timestamps can tie, and
    // the replay is ordered by createdAt): the turn lease makes this the only writer.
    const last = await this.prisma.copilotMessage.findFirst({
      where: { sessionId, workspaceId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { createdAt: true },
    });
    const createdAt = new Date(Math.max(Date.now(), last ? last.createdAt.getTime() + 1 : 0));
    const row = await this.prisma.copilotMessage.create({
      data: {
        createdAt,
        workspaceId,
        sessionId,
        role: data.role,
        text: data.text,
        content: json(data.content),
        references: json(data.references),
        attachments: json(data.attachments),
        sources: json(data.sources),
        pageContext: json(data.pageContext),
        usage: json(data.usage),
      },
    });
    // Bump the session (history order).
    await this.prisma.copilotSession.updateMany({ where: { id: sessionId, workspaceId }, data: { updatedAt: new Date() } });
    return row;
  }

  /** The replay for the next model call (see the file comment). */
  async transcript(workspaceId: string, sessionId: string): Promise<Anthropic.Beta.BetaMessageParam[]> {
    const rows = await this.prisma.copilotMessage.findMany({
      where: { sessionId, workspaceId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { role: true, content: true },
    });
    // Group rows into turns: a turn starts at each user row.
    const turns: Anthropic.Beta.BetaMessageParam[][] = [];
    for (const r of rows) {
      const msgs = Array.isArray(r.content) ? (r.content as unknown as Anthropic.Beta.BetaMessageParam[]) : [];
      if (!msgs.length) continue;
      if (r.role === "user" || turns.length === 0) turns.push([]);
      turns[turns.length - 1].push(...msgs);
    }
    // Every turn but the last (the one being answered) must end with an assistant message.
    for (let i = 0; i < turns.length - 1; i++) turns[i] = closeTranscript(turns[i]);
    if (turns.length <= TRANSCRIPT_TURNS_SENT) return turns.flat();
    const kept = turns.slice(-TRANSCRIPT_TURNS_SENT).flat();
    return [{ role: "user", content: [{ type: "text", text: EARLIER_NOTE }] }, { role: "assistant", content: [{ type: "text", text: "Understood." }] }, ...withoutThinking(kept)];
  }
}
