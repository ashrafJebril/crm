/**
 * SP-18 one copilot turn: validate, then stream the manual tool loop.
 *
 * prepare() runs before the stream is opened, so its refusals are normal HTTP
 * errors: the message (400), the caps (429), availability (503), the
 * member's session (404 for anyone else's), the references (403
 * `copilot.ref_not_permitted` before any model call), the page context (400)
 * and the one-turn-per-session lease (409 `copilot.turn_running`).
 *
 * run() is the manual loop (claude-api skill), streamed:
 *  - ≤ MAX_ITERATIONS model calls and ≤ MAX_TOOL_CALLS tool calls a turn;
 *    CALL_TIMEOUT_MS per call and TURN_BUDGET_MS per turn;
 *  - `stop_reason` is checked before any tool runs: `refusal` →
 *    `error {copilot.refused}`, `max_tokens` → `error {copilot.ai_failed}`;
 *  - every tool input is validated with its zod schema (failure → an
 *    `is_error` result, nothing runs); an unknown tool → `is_error`; all
 *    results of one response go back in one user message;
 *  - a tool input the SDK could not parse (eager input streaming) re-issues
 *    the call once;
 *  - every stream ends with `done` or `error`, and the transcript is closed
 *    (unanswered tool calls answered, a final assistant message) so the next
 *    turn's replay stays valid;
 *  - the turn outlives the client: `emit` is a no-op once the response is
 *    closed; the result is persisted and the lease released.
 *
 * Prompts, replies, tool inputs and results are never logged; usage numbers
 * are stored per assistant message (SP-28).
 */
import { Inject, Injectable, Logger } from "@nestjs/common";
import type Anthropic from "@anthropic-ai/sdk";
import { ZodObject } from "zod";
import { PrismaService } from "../prisma/prisma.service";
import { PermissionService } from "../permissions/permission.service";
import type { Viewer } from "../permissions/visibility";
import { RecordsService } from "../records/records.service";
import { ClaudeService } from "../ai/claude.service";
import { ClaudeFailure } from "../ai/claude-errors";
import { SlidingWindowLimiter } from "../common/rate-limit";
import {
  ATTACH_MAX_PER_MESSAGE,
  CALL_TIMEOUT_MS,
  COPILOT_DAILY_TURNS,
  COPILOT_RATE,
  MAX_ITERATIONS,
  MAX_TOOL_CALLS,
  MESSAGE_MAX,
  TOOL_RESULT_MAX,
  TURN_BUDGET_MS,
  type StreamEventName,
} from "./copilot-constants";
import { copilotError, type StreamErrorCode } from "./copilot-errors";
import type { CopilotStreamDto } from "./copilot.dto";
import { buildChatRequest, closeTranscript, contextMessage, copilotModel } from "./copilot-model";
import { COPILOT_SYSTEM, recordsBlock, turnContext } from "./copilot-prompt";
import { CopilotRefsService } from "./copilot-refs.service";
import { CopilotSessionsService } from "./copilot-sessions.service";
import { SourceCollector } from "./copilot-sources";
import { fallbackTitle, makeTitle } from "./copilot-title";
import { CopilotToolRegistry, noAccess, type ToolContext } from "./copilot-tools/registry";

export const COPILOT_REGISTRY = Symbol("COPILOT_REGISTRY");

export type Emit = (event: StreamEventName, data: unknown) => void;

export interface PreparedTurn {
  sessionId: string;
  title: string | null;
  /** Never throws; always emits `done` or `error` last. */
  run(emit: Emit): Promise<void>;
}

const envInt = (name: string, d: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : d;
};

export { closeTranscript } from "./copilot-model";

@Injectable()
export class CopilotTurnService {
  private readonly log = new Logger(CopilotTurnService.name);
  /** Per-call and per-turn wall clocks (overridable in specs). */
  protected callTimeoutMs = CALL_TIMEOUT_MS;
  protected turnBudgetMs = TURN_BUDGET_MS;
  private readonly limiter = new SlidingWindowLimiter({ limit: envInt("COPILOT_RATE_TURNS", COPILOT_RATE.turns), windowMs: COPILOT_RATE.windowMs });

  constructor(
    private readonly prisma: PrismaService,
    private readonly claude: ClaudeService,
    private readonly sessions: CopilotSessionsService,
    private readonly refs: CopilotRefsService,
    private readonly perm: PermissionService,
    private readonly records: RecordsService,
    @Inject(COPILOT_REGISTRY) private readonly registry: CopilotToolRegistry,
  ) {}

  status(): { available: boolean; reasons: string[] } {
    return this.claude.available() ? { available: true, reasons: [] } : { available: false, reasons: ["no_key"] };
  }

  /** Turns started today (UTC) in the workspace; 429 `copilot.daily_limit` at the cap. */
  private async dailyCheck(workspaceId: string, now: Date): Promise<void> {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const used = await this.prisma.copilotMessage.count({ where: { workspaceId, role: "user", createdAt: { gte: start } } });
    if (used >= envInt("COPILOT_DAILY_TURNS", COPILOT_DAILY_TURNS)) {
      const next = start.getTime() + 24 * 60 * 60 * 1000;
      throw copilotError("copilot.daily_limit", { retryAfterSeconds: Math.max(1, Math.ceil((next - now.getTime()) / 1000)) });
    }
  }

  /** The permissions any copilot tool needs that the member lacks (for the context message). */
  private async missing(workspaceId: string, viewer: Viewer): Promise<string[]> {
    const all = new Set<string>();
    for (const name of this.registry.names()) for (const p of this.registry.get(name)!.permissions) all.add(p);
    const out: string[] = [];
    for (const p of [...all].sort()) if (!(await this.perm.viewerCan(workspaceId, viewer, p))) out.push(p);
    return out;
  }

  async prepare(workspaceId: string, viewer: Viewer, dto: CopilotStreamDto, now = new Date()): Promise<PreparedTurn> {
    const message = typeof dto.message === "string" ? dto.message.trim() : "";
    if (!message || message.length > MESSAGE_MAX) throw copilotError("copilot.message_invalid", { max: MESSAGE_MAX });
    if ((dto.attachmentIds?.length ?? 0) > ATTACH_MAX_PER_MESSAGE) throw copilotError("copilot.too_many_attachments", { max: ATTACH_MAX_PER_MESSAGE });
    if (!this.claude.available()) throw copilotError("copilot.unavailable");

    // The member's own session (404 for anyone else's) before any other work.
    const existing = dto.sessionId ? await this.sessions.own(workspaceId, viewer.userId, dto.sessionId) : null;
    // References: the whole message is refused before any model call (403 {index}).
    const references = await this.refs.resolve(workspaceId, viewer, dto.references);
    // Page context: a record is re-read as the member; never trusted from the client.
    let pageRecord: { kind: string; id: string; title: string; fields: unknown } | null = null;
    if (dto.pageContext?.recordKind || dto.pageContext?.recordId) {
      const pc = dto.pageContext;
      if (!pc.recordKind || !pc.recordId) throw copilotError("copilot.page_context_invalid");
      try {
        const r = await this.records.get(workspaceId, viewer, pc.recordKind, pc.recordId);
        pageRecord = { kind: r.kind, id: r.id, title: r.title, fields: r.fields };
      } catch {
        throw copilotError("copilot.page_context_invalid");
      }
    }

    const hit = this.limiter.hit(`${workspaceId}:${viewer.userId}`);
    if (!hit.ok) throw copilotError("copilot.rate", { retryAfterSeconds: hit.retryAfterSec });
    await this.dailyCheck(workspaceId, now);

    const session = existing ?? (await this.sessions.create(workspaceId, viewer.userId));
    await this.sessions.acquireTurn(workspaceId, viewer.userId, session.id, now);
    try {
      const [user, eff, missing, ws] = await Promise.all([
        this.prisma.user.findUnique({ where: { id: viewer.userId }, select: { name: true } }),
        viewer.bypass ? Promise.resolve(null) : this.perm.effective(workspaceId, viewer.userId),
        this.missing(workspaceId, viewer),
        this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { timezone: true } }),
      ]);
      const model = copilotModel(this.claude);
      // Record data goes in the member's message as data (never the system channel); customer-writable kinds taint.
      const records = recordsBlock(references, pageRecord);
      let tainted = session.tainted;
      if (records?.tainting && !tainted) {
        tainted = true;
        await this.sessions.markTainted(workspaceId, session.id);
      }
      const context = turnContext({
        lang: dto.lang,
        member: { name: user?.name ?? "Member", roleName: eff ? (dto.lang === "ar" ? eff.nameAr || eff.name : eff.name) : null },
        missingPermissions: missing,
        approvalMode: dto.approvalMode,
        now,
        tz: ws?.timezone ?? "Asia/Riyadh",
        page: dto.pageContext
          ? {
              page: dto.pageContext.page,
              record: pageRecord ? { kind: pageRecord.kind, id: pageRecord.id } : null,
              range: { from: dto.pageContext.from, to: dto.pageContext.to },
              channelId: dto.pageContext.channelId,
              pipelineId: dto.pageContext.pipelineId,
            }
          : null,
        referenceCount: references.length,
        tainted,
      });
      const ctxMsg = contextMessage(model, context);
      const userBlocks: Anthropic.Beta.BetaContentBlockParam[] = [{ type: "text", text: message }];
      if (records) userBlocks.push({ type: "text", text: records.text });
      if (ctxMsg.userBlock) userBlocks.push(ctxMsg.userBlock);
      const userContent: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: userBlocks }];
      if (ctxMsg.system) userContent.push(ctxMsg.system);
      await this.sessions.append(workspaceId, session.id, {
        role: "user",
        text: message,
        content: userContent,
        references: references.map((r) => ({ kind: r.kind, id: r.id, title: r.title })),
        pageContext: dto.pageContext ? { ...dto.pageContext } : undefined,
      });
      const isFirst = !session.title;
      return {
        sessionId: session.id,
        title: session.title,
        run: (emit) => this.run({ workspaceId, viewer, sessionId: session.id, lang: dto.lang, model, message, isFirst, tainted }, emit),
      };
    } catch (e) {
      await this.sessions.releaseTurn(workspaceId, session.id).catch(() => undefined);
      throw e;
    }
  }

  private async run(
    t: { workspaceId: string; viewer: Viewer; sessionId: string; lang: "en" | "ar"; model: string; message: string; isFirst: boolean; tainted: boolean },
    emitRaw: Emit,
  ): Promise<void> {
    let ended = false;
    const emit: Emit = (event, data) => {
      if (ended) return;
      if (event === "done" || event === "error") ended = true;
      try {
        emitRaw(event, data);
      } catch {
        /* the client went away; the turn goes on */
      }
    };
    const started = Date.now();
    const deadline = started + this.turnBudgetMs;
    const sources = new SourceCollector();
    let tainted = t.tainted;
    const ctx: ToolContext = {
      workspaceId: t.workspaceId,
      viewer: t.viewer,
      sessionId: t.sessionId,
      lang: t.lang,
      now: new Date(),
      sources,
      taint: () => {
        if (tainted) return;
        tainted = true;
        void this.sessions.markTainted(t.workspaceId, t.sessionId).catch(() => undefined);
      },
      emit: (event, data) => emit(event as StreamEventName, data),
    };
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, model: t.model };
    const turnMsgs: Anthropic.Beta.BetaMessageParam[] = [];
    let finalText = "";
    let errorCode: StreamErrorCode | null = null;
    try {
      const history = await this.sessions.transcript(t.workspaceId, t.sessionId);
      const tools = this.registry.definitions();
      let toolCalls = 0;
      let reissued = false;
      for (let i = 0; ; i++) {
        if (i >= MAX_ITERATIONS) {
          errorCode = "copilot.limit";
          break;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          errorCode = "copilot.timeout";
          break;
        }
        emit("activity", { kind: "thinking", label: t.lang === "ar" ? "يفكّر…" : "Thinking…" });
        let res: Anthropic.Beta.BetaMessage;
        try {
          res = await this.claude.streamText(
            buildChatRequest(this.claude, { model: t.model, system: COPILOT_SYSTEM, tools, messages: [...history, ...turnMsgs] }),
            "copilot turn",
            { timeoutMs: Math.min(this.callTimeoutMs, remaining), onText: (text) => emit("token", { text }) },
          );
        } catch (e) {
          if (e instanceof ClaudeFailure && e.stopReason === "invalid_tool_json" && !reissued) {
            reissued = true; // re-issue once: the failed response was never appended
            continue;
          }
          if (e instanceof ClaudeFailure && e.stopReason === "timeout") errorCode = "copilot.timeout";
          else errorCode = "copilot.ai_failed";
          break;
        }
        usage.inputTokens += res.usage?.input_tokens ?? 0;
        usage.outputTokens += res.usage?.output_tokens ?? 0;
        usage.cacheReadInputTokens += res.usage?.cache_read_input_tokens ?? 0;
        usage.cacheCreationInputTokens += res.usage?.cache_creation_input_tokens ?? 0;
        // stop_reason before any tool runs.
        if (res.stop_reason === "refusal") {
          errorCode = "copilot.refused";
          break;
        }
        if (res.stop_reason === "max_tokens") {
          errorCode = "copilot.ai_failed";
          break;
        }
        turnMsgs.push({ role: "assistant", content: res.content as Anthropic.Beta.BetaContentBlockParam[] });
        if (res.stop_reason === "pause_turn") continue;
        if (res.stop_reason === "tool_use") {
          const uses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
          if (toolCalls + uses.length > MAX_TOOL_CALLS) {
            errorCode = "copilot.limit";
            break;
          }
          toolCalls += uses.length;
          const results = await Promise.all(uses.map((u) => this.runTool(ctx, u, emit)));
          turnMsgs.push({ role: "user", content: results });
          continue;
        }
        finalText = res.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        break;
      }
    } catch (e) {
      this.log.warn(`copilot turn failed: ${(e as Error)?.name ?? "error"}`);
      errorCode = "copilot.ai_failed";
    }

    try {
      const content = errorCode ? closeTranscript(turnMsgs) : turnMsgs;
      const sourceList = sources.list();
      const saved = await this.sessions.append(t.workspaceId, t.sessionId, {
        role: errorCode ? "note" : "assistant",
        text: errorCode ? errorCode : finalText,
        content,
        sources: sourceList.length ? sourceList : undefined,
        usage,
      });
      if (errorCode) {
        emit("error", { code: errorCode });
      } else {
        if (sourceList.length) emit("sources", { items: sourceList });
        if (t.isFirst) {
          const title = await makeTitle(this.claude, t.message, finalText).catch(() => fallbackTitle(t.message));
          await this.sessions.setTitle(t.workspaceId, t.sessionId, title).catch(() => undefined);
        }
        emit("done", { messageId: saved.id, usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } });
      }
    } catch (e) {
      this.log.warn(`copilot turn could not be saved: ${(e as Error)?.name ?? "error"}`);
      emit("error", { code: "copilot.ai_failed" });
    } finally {
      await this.sessions.releaseTurn(t.workspaceId, t.sessionId).catch(() => undefined);
    }
  }

  /** One tool call → one tool_result (never throws). */
  private async runTool(ctx: ToolContext, use: Anthropic.Beta.BetaToolUseBlock, emit: Emit): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
    const err = (text: string): Anthropic.Beta.BetaToolResultBlockParam => ({ type: "tool_result", tool_use_id: use.id, is_error: true, content: text });
    const tool = this.registry.get(use.name);
    if (!tool) return err(`Unknown tool: ${use.name}`);
    emit("activity", { kind: use.name === "draft_reply" ? "drafting" : "tool", tool: tool.name, label: ctx.lang === "ar" ? tool.label[1] : tool.label[0] });
    // Parse (never match strings) and validate before anything runs.
    let input: unknown = use.input;
    if (typeof input === "string") {
      try {
        input = JSON.parse(input);
      } catch {
        return err(JSON.stringify({ INVALID_JSON: String(use.input).slice(0, 2000) }));
      }
    }
    // Strict like the tool definition (additionalProperties: false): unknown keys fail too.
    const schema = tool.inputSchema instanceof ZodObject ? tool.inputSchema.strict() : tool.inputSchema;
    const parsed = schema.safeParse(input ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`);
      return err(`Invalid input. ${issues.join("; ")}`.slice(0, 1000));
    }
    // As the member: each listed permission first; missing → no data.
    for (const p of tool.permissions) {
      if (!(await this.perm.viewerCan(ctx.workspaceId, ctx.viewer, p))) {
        return { type: "tool_result", tool_use_id: use.id, content: JSON.stringify(noAccess(p)) };
      }
    }
    if (tool.kind !== "read") return err("This change cannot be made from here yet.");
    try {
      const out = await tool.execute(ctx, parsed.data as never);
      const text = JSON.stringify(out ?? null) ?? "null";
      return { type: "tool_result", tool_use_id: use.id, content: text.length > TOOL_RESULT_MAX ? `${text.slice(0, TOOL_RESULT_MAX)}…` : text };
    } catch {
      return err("The tool failed. Try again or ask differently.");
    }
  }
}
