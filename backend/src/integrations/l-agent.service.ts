import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Asks a workspace's l agent a question and returns its answer.
 *
 * Nothing more: no persistence, no sending. Two callers need the same request
 * for different reasons — an inbox reply going back to an l-origin chat, and an
 * inbound social message being auto-answered — and they disagree about what to
 * do with the answer. Keeping this to the HTTP call is what lets them share it.
 *
 * Never throws. Every failure is a null answer plus a log line, because both
 * callers are on paths where the customer's message is already stored and a
 * struggling agent platform must not turn that into a failed request.
 */
/** One earlier turn of a test conversation, as l's `dry_run` takes it. */
export interface LTryHistoryTurn {
  role: "user" | "assistant";
  content: string;
}

/** l's answer to a test turn. */
export interface LTryTurn {
  answer: string;
  citations: string[];
  /** The tools the agent called, in order, with l's own (MCP-prefixed) names. */
  toolCalls: { name: string; args: Record<string, unknown> }[];
}

/** A test turn that l could not answer (unreachable, an error status, a bad body). */
export class LTryTurnError extends Error {}

/** l's `dry_run` history cap and per-turn text cap. */
const TRY_HISTORY_MAX = 50;
const TRY_TEXT_MAX = 8_000;

/** A customer file handed to l: a short-lived URL it can fetch. */
export type LAttachment = { url: string; mimeType: string; kind: "image" | "audio" | "video" | "file" };
/** What l read a file as: a voice note's transcript, an image's description. handled=false → a person should look. */
export type LMediaResult = { kind: string; text: string | null; handled: boolean };

@Injectable()
export class LAgentService {
  private readonly logger = new Logger(LAgentService.name);

  // An l turn invokes a model, and a turn that consults the knowledge base
  // costs a retrieval plus a second model round trip — measured at 8-10s, so
  // 30s was only ~3x headroom on a path nobody is waiting on synchronously.
  // Generous here is cheap: the caller already returned, so the only cost of
  // waiting is a held socket, while giving up early loses the customer's reply.
  private static readonly TIMEOUT_MS = 60_000;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Whether an l platform is configured at all. Callers check this before
   * doing any work of their own, so a deployment without l pays nothing —
   * not even a lookup — on every inbound message.
   */
  get enabled(): boolean {
    return Boolean(process.env.L_API_URL);
  }

  /**
   * One test turn of the workspace's real l agent ("Try your agent"), using
   * l's `dry_run`: the live prompt, knowledge and tools, with nothing stored
   * on l and every write refused (our MCP server and connector proxy see
   * `X-Kewy-Dry-Run: 1`). l keeps no test conversation, so `history` is ours.
   *
   * Returns null when the workspace is not linked to l (the caller previews
   * on its own instead). Unlike `ask`, a failure throws `LTryTurnError`: an
   * owner is waiting on this answer and should be told it failed.
   */
  /** Whether `tryTurn` would reach l for this workspace (no network call). */
  async isLinked(workspaceId: string): Promise<boolean> {
    if (!process.env.L_API_URL) return false;
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { lEndpointId: true, lEndpointSecret: true },
    });
    return Boolean(workspace?.lEndpointId && workspace.lEndpointSecret);
  }

  async tryTurn(
    workspaceId: string,
    opts: { message: string; history: LTryHistoryTurn[]; timeoutMs: number },
  ): Promise<LTryTurn | null> {
    const baseUrl = process.env.L_API_URL;
    if (!baseUrl) return null;
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { lEndpointId: true, lEndpointSecret: true },
    });
    if (!workspace?.lEndpointId || !workspace.lEndpointSecret) return null;

    const url =
      `${baseUrl.replace(/\/$/, "")}/api/v1/webhooks/` +
      `${encodeURIComponent(workspace.lEndpointId)}/messages`;
    const history = opts.history
      .filter((t) => t.content.trim().length > 0)
      .slice(-TRY_HISTORY_MAX)
      .map((t) => ({ role: t.role, content: t.content.slice(0, TRY_TEXT_MAX) }));

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-webhook-secret": workspace.lEndpointSecret },
        body: JSON.stringify({ external_id: "try-your-agent", message: opts.message, dry_run: true, history }),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
    } catch (err) {
      throw new LTryTurnError(`l unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) throw new LTryTurnError(`l returned ${res.status}`);

    const body = (await res.json().catch(() => null)) as {
      answer?: unknown;
      citations?: unknown;
      tool_calls?: unknown;
    } | null;
    if (!body || typeof body.answer !== "string") throw new LTryTurnError("l returned no answer");
    const citations = Array.isArray(body.citations) ? body.citations.filter((c): c is string => typeof c === "string") : [];
    const toolCalls = Array.isArray(body.tool_calls)
      ? body.tool_calls
          .filter((c): c is { name: string; args?: unknown } => typeof c?.name === "string")
          .map((c) => ({
            name: c.name,
            args: c.args && typeof c.args === "object" && !Array.isArray(c.args) ? (c.args as Record<string, unknown>) : {},
          }))
      : [];
    return { answer: body.answer, citations, toolCalls };
  }

  async ask(
    workspaceId: string,
    opts: {
      externalId: string;
      message: string;
      sessionId?: string | null;
      /** Files the customer sent with this message; l reads them into text (voice → transcript). */
      attachments?: LAttachment[];
    },
  ): Promise<{ answer: string; imageUrl?: string; media?: LMediaResult[] } | null> {
    const baseUrl = process.env.L_API_URL;
    if (!baseUrl) return null;

    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { lEndpointId: true, lEndpointSecret: true },
    });
    if (!workspace?.lEndpointId || !workspace.lEndpointSecret) {
      this.logger.warn(
        `Workspace ${workspaceId} has no l webhook endpoint configured; not asking the agent`,
      );
      return null;
    }

    const url =
      `${baseUrl.replace(/\/$/, "")}/api/v1/webhooks/` +
      `${encodeURIComponent(workspace.lEndpointId)}/messages`;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-secret": workspace.lEndpointSecret,
        },
        body: JSON.stringify({
          external_id: opts.externalId,
          message: opts.message,
          ...(opts.attachments?.length
            ? { attachments: opts.attachments.map((a) => ({ url: a.url, mime_type: a.mimeType, kind: a.kind })) }
            : {}),
          // Present only for threads that already exist on the l side. Absent,
          // l finds-or-creates its own conversation keyed by external_id —
          // which is what a social thread wants: one stable l conversation per
          // CRM thread, so the agent keeps its context across turns.
          ...(opts.sessionId ? { session_id: opts.sessionId } : {}),
        }),
        signal: AbortSignal.timeout(LAgentService.TIMEOUT_MS),
      });

      if (!res.ok) {
        this.logger.warn(`l returned ${res.status} for conversation ${opts.externalId}`);
        return null;
      }
      const payload = (await res.json()) as { answer?: unknown; image_url?: unknown; media?: unknown };
      if (typeof payload.answer !== "string" || payload.answer.length === 0) {
        this.logger.warn(`l returned no answer for conversation ${opts.externalId}`);
        return null;
      }
      const imageUrl = typeof payload.image_url === "string" ? payload.image_url : undefined;
      const media = Array.isArray(payload.media)
        ? payload.media
            .filter((m): m is { kind: unknown; text?: unknown; handled?: unknown } => !!m && typeof m === "object")
            .map((m) => ({
              kind: String(m.kind),
              text: typeof m.text === "string" ? m.text : null,
              handled: m.handled === true,
            }))
        : undefined;
      return { answer: payload.answer, imageUrl, ...(media ? { media } : {}) };
    } catch (err) {
      this.logger.warn(
        `Could not reach l for conversation ${opts.externalId}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return null;
    }
  }
}
