/**
 * SP-20 "Try your agent" (ruling 2): a CRM-side preview of the customer
 * agent on Claude, for owners and admins (`agent.update`, ruling 9).
 *
 * A workspace linked to l is tried on the real agent instead (`engine:
 * "live"`): each turn is an l `dry_run` with this thread as its history, so
 * the live prompt, knowledge and tools answer, nothing is stored on l, and
 * every write is refused by our MCP server and connector proxy (they see
 * `X-Kewy-Dry-Run: 1`). Reads there run as the workspace's agent, not with
 * the member's own permissions. Everything below describes the preview.
 *
 *  - Same prompt (the live l prompt when linked, else our CRM sections; the
 *    latest persona and guidelines; a fixed preview notice), same CRM tools
 *    in sandbox mode (deny by default: only SANDBOX_READ_TOOLS execute; every
 *    other tool returns a "NOT saved" mock), and SP-21 `search_knowledge`.
 *  - Nothing is created: the only row written is the member's
 *    AgentSandboxThread. No conversation, contact, message, ticket, booking,
 *    activity, notification, realtime event or workflow event; no channel or
 *    agent platform is ever messaged (the live prompt is read with GETs only).
 *  - Manual tool loop (claude-api skill): non-streaming, ≤ SANDBOX_MAX_ITERATIONS
 *    calls and ≤ SANDBOX_MAX_TOOL_CALLS tool calls a turn, SANDBOX_TIMEOUT_MS in
 *    all. `stop_reason` is checked before content: refusal → a fixed reply,
 *    max_tokens → `agent.ai_failed`. Parallel tool results go back in one user
 *    message; a failed or invalid call is a `tool_result` with `is_error`.
 *    Inputs are validated with the tool's zod schema before execution.
 *  - The model transcript is append-only (prompt cache, preserved thinking):
 *    `system` and `tools` are fixed for a transcript (hashed); the per-turn
 *    date/time and gate note is a mid-conversation `system` message after the
 *    owner's message. When the system prompt or tools change, or the thread
 *    reaches SANDBOX_MAX_TURNS, the next turn starts a fresh transcript with a
 *    short plain-text recap (no earlier thinking replayed).
 *  - Prompts and replies are never logged; usage is logged as numbers only.
 */
import { createHash } from "crypto";
import { Injectable, Logger, Optional } from "@nestjs/common";
import type Anthropic from "@anthropic-ai/sdk";
import type { ZodTypeAny } from "zod";
import { PrismaService } from "../../prisma/prisma.service";
import { ClaudeService } from "../../ai/claude.service";
import { ClaudeFailure } from "../../ai/claude-errors";
import { McpToolsFactory } from "../../mcp-server/mcp-tools.factory";
import { SkillsService } from "../../skills/skills.service";
import { CRM_MCP_SERVER_NAME, LAgentSetupService, crmPromptSections } from "../../integrations/l-agent-setup.service";
import { LAgentService, LTryTurnError, type LTryTurn } from "../../integrations/l-agent.service";
import { KnowledgeSourcesService } from "../../knowledge-sources/knowledge-sources.service";

/** The sandbox prompt block that holds the agent's guidelines (stored on l). */
const GUIDELINES_BLOCK = "guidelines";
import { SlidingWindowLimiter } from "../../common/rate-limit";
import {
  SANDBOX_MAX_ITERATIONS,
  SANDBOX_MAX_TOOL_CALLS,
  SANDBOX_MAX_TURNS,
  SANDBOX_MESSAGE_MAX,
  SANDBOX_RATE,
  SANDBOX_TIMEOUT_MS,
  SANDBOX_TTL_MS,
} from "../agent-constants";
import { agentError } from "../agent-errors";
import { AgentReplyGate } from "../agent-reply-gate";
import { personaBlockText } from "../persona-block";
import { composeSandboxSystem, turnNote } from "./sandbox-prompt";
import { PREVIEW_EMPTY_REPLY, PREVIEW_REFUSAL_REPLY } from "./sandbox-text";
import { displayArgs, isSandboxReadTool, READ_TOOL_PERMISSIONS, toolDefinitions, type SandboxableTool } from "./sandbox-tools";
import { PermissionService } from "../../permissions/permission.service";
import type { Viewer } from "../../permissions/visibility";

export const SANDBOX_MODEL_ENV = "AGENT_SANDBOX_MODEL";
/** The live l prompt is re-read at most this often per workspace. */
export const LIVE_PROMPT_CACHE_MS = 60_000;
/** Characters of one tool result sent back to the model. */
export const TOOL_RESULT_MAX = 20_000;
/** Models that accept a mid-conversation `role: "system"` message (claude-api skill). */
const SYSTEM_MESSAGE_MODELS: ReadonlySet<string> = new Set([
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-fable-5",
  "claude-fable-5-1",
  "claude-fable-5-2",
  "claude-mythos-5",
  "claude-mythos-5-1",
  "claude-mythos-5-2",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
]);

export interface SandboxToolCall {
  name: string;
  simulated: boolean;
  args?: Record<string, string>;
  /** The call failed (bad input, unknown tool, a service error, the per-turn cap). */
  error?: boolean;
}
export interface SandboxSource {
  sourceId: string;
  title: string;
  url?: string;
}
export interface SandboxTurn {
  role: "owner" | "agent";
  text: string;
  toolCalls?: SandboxToolCall[];
  sources?: SandboxSource[];
  at: string;
}
/** "live": the real l agent answered (a dry run); "preview": the CRM-side preview on Claude. */
export type SandboxEngine = "live" | "preview";

export interface SandboxReplyDto {
  engine: SandboxEngine;
  reply: string;
  /** "answer"; or a fixed bilingual reply: "refusal" (the model declined) or "empty" (it ended with no text). */
  replyKind: "answer" | "refusal" | "empty";
  toolCalls: SandboxToolCall[];
  sources: SandboxSource[];
  gate: { wouldReply: boolean; reason: string };
  turnCount: number;
}
export interface SandboxThreadDto {
  engine: SandboxEngine;
  messages: SandboxTurn[];
  turnCount: number;
  expiresAt: string | null;
}

interface Transcript {
  key: string;
  turns: number;
  messages: Anthropic.Beta.BetaMessageParam[];
}

const emptyTranscript = (key: string): Transcript => ({ key, turns: 0, messages: [] });

function readTranscript(raw: unknown): Transcript | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const t = raw as Partial<Transcript>;
  return typeof t.key === "string" && Array.isArray(t.messages) ? { key: t.key, turns: Number(t.turns) || 0, messages: t.messages } : null;
}

function readTurns(raw: unknown): SandboxTurn[] {
  return Array.isArray(raw) ? (raw as SandboxTurn[]) : [];
}

const countTurns = (turns: SandboxTurn[]) => turns.filter((t) => t.role === "owner").length;

/** Keep the last `max` owner turns (each with the agent reply after it). */
export function keepLastTurns(turns: SandboxTurn[], max: number): SandboxTurn[] {
  const owners = turns.map((t, i) => (t.role === "owner" ? i : -1)).filter((i) => i >= 0);
  return owners.length > max ? turns.slice(owners[owners.length - max]) : turns;
}

/** http(s) only; anything else is dropped from the "Answered from" list. */
function httpUrl(u: unknown): string | undefined {
  if (typeof u !== "string") return undefined;
  try {
    const p = new URL(u);
    return p.protocol === "https:" || p.protocol === "http:" ? p.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** "Answered from": search_knowledge results, deduped by source. */
export function sourcesFrom(result: unknown, into: Map<string, SandboxSource>): void {
  const rows = (result as { results?: unknown })?.results;
  if (!Array.isArray(rows)) return;
  for (const r of rows as { sourceId?: unknown; sourceTitle?: unknown; url?: unknown }[]) {
    if (typeof r?.sourceId !== "string" || into.has(r.sourceId)) continue;
    const url = httpUrl(r.url);
    into.set(r.sourceId, { sourceId: r.sourceId, title: String(r.sourceTitle ?? "").slice(0, 200), ...(url ? { url } : {}) });
  }
}

/** l's MCP prefix for our own tools: `kewy_crm_find_slots` is our `find_slots`. */
const CRM_TOOL_PREFIX = `${CRM_MCP_SERVER_NAME}_`;

/**
 * l's tool calls as the panel shows them. Our own tools lose l's prefix and
 * are marked simulated by the same policy our MCP server applied to them in
 * the dry run. Anything else (a connector, an l HTTP tool, l's knowledge
 * search) keeps its name; its writes were refused on the far side.
 */
export function liveToolCalls(calls: LTryTurn["toolCalls"]): SandboxToolCall[] {
  return calls.map((c) => {
    const ours = c.name.startsWith(CRM_TOOL_PREFIX);
    const name = ours ? c.name.slice(CRM_TOOL_PREFIX.length) : c.name;
    return { name, simulated: ours && !isSandboxReadTool(name), args: displayArgs(c.args) };
  });
}

function recap(turns: SandboxTurn[]): string {
  const last = turns.slice(-12);
  if (!last.length) return "";
  const lines = last.map((t) => `${t.role === "owner" ? "Owner" : "Agent"}: ${t.text.replace(/\s+/g, " ").slice(0, 300)}`);
  return `Earlier in this preview chat (for context only):\n${lines.join("\n")}`.slice(0, 4000);
}

@Injectable()
export class SandboxService {
  private readonly log = new Logger(SandboxService.name);
  private readonly limiter: SlidingWindowLimiter;
  private readonly livePrompts = new Map<string, { at: number; prompt: string | null }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly claude: ClaudeService,
    private readonly tools: McpToolsFactory,
    private readonly gate: AgentReplyGate,
    @Optional() private readonly agentSetup?: LAgentSetupService,
    // Review: read tools run with the member's own permissions (global PermissionsModule; specs may omit it).
    @Optional() private readonly perm?: PermissionService,
    // SP-22: the sandbox offers the same tools as the live agent (enabled skills).
    @Optional() private readonly skills?: SkillsService,
    // A linked workspace is tried on its real l agent (a dry run).
    @Optional() private readonly lAgent?: LAgentService,
    // The agent's guidelines (on l) for the preview prompt.
    @Optional() private readonly knowledge?: KnowledgeSourcesService,
  ) {
    this.limiter = new SlidingWindowLimiter({ limit: SANDBOX_RATE.turns, windowMs: SANDBOX_RATE.windowMs });
  }

  // ── thread ────────────────────────────────────────────────────────────

  private async thread(workspaceId: string, userId: string, now: Date) {
    const row = await this.prisma.agentSandboxThread.findFirst({ where: { workspaceId, userId } });
    if (!row || row.expiresAt.getTime() <= now.getTime()) return null;
    return row;
  }

  private async engine(workspaceId: string): Promise<SandboxEngine> {
    return this.lAgent && (await this.lAgent.isLinked(workspaceId)) ? "live" : "preview";
  }

  async get(workspaceId: string, userId: string, now = new Date()): Promise<SandboxThreadDto> {
    const [row, engine] = await Promise.all([this.thread(workspaceId, userId, now), this.engine(workspaceId)]);
    if (!row) return { engine, messages: [], turnCount: 0, expiresAt: null };
    const messages = readTurns(row.messages);
    return { engine, messages, turnCount: countTurns(messages), expiresAt: row.expiresAt.toISOString() };
  }

  async reset(workspaceId: string, userId: string): Promise<{ ok: true }> {
    await this.prisma.agentSandboxThread.deleteMany({ where: { workspaceId, userId } });
    return { ok: true };
  }

  /** The daily sweep: threads past their expiry. */
  async sweepExpired(now = new Date()): Promise<number> {
    const r = await this.prisma.agentSandboxThread.deleteMany({ where: { expiresAt: { lt: now } } });
    return r.count;
  }

  // ── prompt ────────────────────────────────────────────────────────────

  private async livePrompt(workspaceId: string): Promise<string | null> {
    if (!this.agentSetup) return null;
    const hit = this.livePrompts.get(workspaceId);
    if (hit && Date.now() - hit.at < LIVE_PROMPT_CACHE_MS) return hit.prompt;
    let prompt: string | null = null;
    try {
      prompt = await this.agentSetup.readLivePrompt(workspaceId);
    } catch {
      // The platform is unreachable: preview with our own sections.
      this.log.warn(`sandbox: live prompt unavailable for workspace ${workspaceId}; using the CRM sections`);
    }
    this.livePrompts.set(workspaceId, { at: Date.now(), prompt });
    return prompt;
  }

  async systemPrompt(workspaceId: string): Promise<string> {
    const [live, settings, guidelines] = await Promise.all([
      this.livePrompt(workspaceId),
      this.prisma.agentSettings.findUnique({ where: { workspaceId } }),
      this.knowledge ? this.knowledge.getGuidelines(workspaceId).catch(() => null) : Promise.resolve(null),
    ]);
    return composeSandboxSystem({
      live,
      // Review M1: the same blocks as the tools offered (the enabled skills).
      sections: crmPromptSections(this.skills ? await this.skills.enabledFor(workspaceId) : undefined),
      persona: settings ? personaBlockText(settings) : "",
      guidelines: guidelines?.body ?? "",
      guidelinesBlock: GUIDELINES_BLOCK,
    });
  }

  // ── one turn ──────────────────────────────────────────────────────────

  async send(workspaceId: string, userId: string, rawMessage: unknown, now = new Date(), opts: { bypass?: boolean } = {}): Promise<SandboxReplyDto> {
    const viewer: Viewer = { userId, bypass: opts.bypass === true };
    const message = typeof rawMessage === "string" ? rawMessage.trim() : "";
    if (!message || message.length > SANDBOX_MESSAGE_MAX) throw agentError("agent.message_invalid", { max: SANDBOX_MESSAGE_MAX });
    const hit = this.limiter.hit(`${workspaceId}:${userId}`);
    if (!hit.ok) throw agentError("agent.sandbox_rate", { retryAfterSeconds: hit.retryAfterSec });

    const row = await this.thread(workspaceId, userId, now);
    const turns = readTurns(row?.messages);
    const live = await this.sendLive(workspaceId, userId, message, turns, now);
    if (live) return live;
    if (!this.claude.available()) throw agentError("agent.ai_unavailable");

    const enabled = this.skills ? await this.skills.enabledFor(workspaceId) : undefined;
    const tools = this.tools.build(workspaceId, { mode: "sandbox", enabled }) as unknown as Record<string, SandboxableTool>;
    const defs = toolDefinitions(tools);
    const system = await this.systemPrompt(workspaceId);
    const key = createHash("sha256").update(system).update("\u0000").update(JSON.stringify(defs)).digest("hex");
    const stored = readTranscript(row?.transcript);
    const fresh = !stored || stored.key !== key || stored.turns >= SANDBOX_MAX_TURNS;
    const transcript = fresh ? emptyTranscript(key) : stored;

    const gate = await this.gateFor(workspaceId, now);
    const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { timezone: true } });
    const note = turnNote({ now, tz: ws?.timezone ?? "Asia/Riyadh", gate });
    const model = this.claude.model(SANDBOX_MODEL_ENV);
    const systemMessages = SYSTEM_MESSAGE_MODELS.has(model);

    const userContent: Anthropic.Beta.BetaContentBlockParam[] = [];
    const earlier = fresh ? recap(turns) : "";
    if (earlier) userContent.push({ type: "text", text: earlier });
    userContent.push({ type: "text", text: message });
    if (!systemMessages) userContent.push({ type: "text", text: `[Operator note] ${note}` });
    const messages: Anthropic.Beta.BetaMessageParam[] = [...transcript.messages, { role: "user", content: userContent }];
    if (systemMessages) messages.push({ role: "system", content: note });

    const deadline = Date.now() + SANDBOX_TIMEOUT_MS;
    const toolCalls: SandboxToolCall[] = [];
    const sources = new Map<string, SandboxSource>();
    let reply: string | null = null;
    let replyKind: SandboxReplyDto["replyKind"] = "answer";
    try {
      for (let i = 0; i < SANDBOX_MAX_ITERATIONS && reply === null; i++) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new ClaudeFailure("ai_failed", "sandbox turn budget spent");
        const res = await this.claude.create(
          {
            ...this.claude.baseRequest({ model, effort: "medium" }),
            system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
            tools: defs,
            tool_choice: { type: "auto" },
            // A snapshot: the loop keeps appending to `messages`.
            messages: [...messages],
          },
          "sandbox turn",
          { timeoutMs: remaining },
        );
        this.log.debug(
          `sandbox usage: in ${res.usage?.input_tokens ?? 0}, out ${res.usage?.output_tokens ?? 0}, cache read ${res.usage?.cache_read_input_tokens ?? 0}, cache write ${res.usage?.cache_creation_input_tokens ?? 0}`,
        );
        // Check stop_reason before reading content.
        if (res.stop_reason === "refusal") {
          reply = PREVIEW_REFUSAL_REPLY;
          replyKind = "refusal";
          break;
        }
        if (res.stop_reason === "max_tokens") throw new ClaudeFailure("ai_failed", "stop_reason max_tokens", false, "max_tokens");
        messages.push({ role: "assistant", content: res.content as Anthropic.Beta.BetaContentBlockParam[] });
        if (res.stop_reason === "pause_turn") continue;
        if (res.stop_reason === "tool_use") {
          const uses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
          const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
          for (const use of uses) results.push(await this.runTool(workspaceId, viewer, tools, use, toolCalls, sources));
          messages.push({ role: "user", content: results });
          continue;
        }
        reply = res.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        if (!reply) {
          // An end_turn with no text: a fixed bilingual line, never an empty bubble.
          reply = PREVIEW_EMPTY_REPLY;
          replyKind = "empty";
        }
      }
      if (reply === null) throw new ClaudeFailure("ai_failed", "sandbox iteration limit");
    } catch (e) {
      if (e instanceof ClaudeFailure) throw agentError(e.key === "ai_unavailable" ? "agent.ai_unavailable" : "agent.ai_failed");
      throw e;
    }

    const sourceList = [...sources.values()];
    const nextTranscript: Transcript = { key, turns: transcript.turns + 1, messages };
    const turnCount = await this.save(workspaceId, userId, turns, { message, reply, toolCalls, sources: sourceList }, nextTranscript, now);
    return { engine: "preview", reply, replyKind, toolCalls, sources: sourceList, gate, turnCount };
  }

  /** Appends one owner/agent exchange to the member's thread; returns the turn count. */
  private async save(
    workspaceId: string,
    userId: string,
    turns: SandboxTurn[],
    turn: { message: string; reply: string; toolCalls: SandboxToolCall[]; sources: SandboxSource[] },
    transcript: Transcript,
    now: Date,
  ): Promise<number> {
    const at = now.toISOString();
    const { toolCalls, sources } = turn;
    const nextTurns = keepLastTurns(
      [
        ...turns,
        { role: "owner", text: turn.message, at },
        { role: "agent", text: turn.reply, at, ...(toolCalls.length ? { toolCalls } : {}), ...(sources.length ? { sources } : {}) },
      ],
      SANDBOX_MAX_TURNS,
    );
    const expiresAt = new Date(now.getTime() + SANDBOX_TTL_MS);
    const data = {
      messages: nextTurns as unknown as object,
      transcript: transcript as unknown as object,
      expiresAt,
    };
    await this.prisma.agentSandboxThread.upsert({
      where: { workspaceId_userId: { workspaceId, userId } },
      create: { workspaceId, userId, ...data },
      update: data,
    });
    return countTurns(nextTurns);
  }

  private async gateFor(workspaceId: string, now: Date): Promise<SandboxReplyDto["gate"]> {
    return this.gate
      .decide(workspaceId, { conversationId: null, contactId: null, now })
      .then((d) => ({ wouldReply: d.reply, reason: d.reason as string }))
      .catch(() => ({ wouldReply: false, reason: "unknown" }));
  }

  /**
   * One turn on the real l agent, or null when the workspace is not linked
   * (the caller previews on Claude). The thread is the history l replays;
   * l keeps nothing. A failure is `agent.ai_failed`, never a silent switch
   * to the preview: the owner asked to try the real agent.
   */
  private async sendLive(
    workspaceId: string,
    userId: string,
    message: string,
    turns: SandboxTurn[],
    now: Date,
  ): Promise<SandboxReplyDto | null> {
    if (!this.lAgent) return null;
    let result: LTryTurn | null;
    try {
      result = await this.lAgent.tryTurn(workspaceId, {
        message,
        history: turns.map((t) => ({ role: t.role === "owner" ? "user" : "assistant", content: t.text })),
        timeoutMs: SANDBOX_TIMEOUT_MS,
      });
    } catch (e) {
      if (!(e instanceof LTryTurnError)) throw e;
      this.log.warn(`sandbox: the live agent did not answer for workspace ${workspaceId}: ${e.message}`);
      throw agentError("agent.ai_failed");
    }
    if (!result) return null;

    const answer = result.answer.trim();
    const reply = answer || PREVIEW_EMPTY_REPLY;
    const replyKind: SandboxReplyDto["replyKind"] = answer ? "answer" : "empty";
    const toolCalls = liveToolCalls(result.toolCalls);
    // l cites by document name; there is no id or link to offer.
    const sources: SandboxSource[] = [...new Set(result.citations)].map((c) => ({ sourceId: c, title: c.slice(0, 200) }));
    const gate = await this.gateFor(workspaceId, now);
    // The preview's model transcript does not apply to l: start it over, so
    // a later preview turn (the workspace unlinked) begins from a recap.
    const turnCount = await this.save(workspaceId, userId, turns, { message, reply, toolCalls, sources }, emptyTranscript(""), now);
    return { engine: "live", reply, replyKind, toolCalls, sources, gate, turnCount };
  }

  private async runTool(
    workspaceId: string,
    viewer: Viewer,
    tools: Record<string, SandboxableTool>,
    use: Anthropic.Beta.BetaToolUseBlock,
    calls: SandboxToolCall[],
    sources: Map<string, SandboxSource>,
  ): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
    const fail = (text: string, call: SandboxToolCall): Anthropic.Beta.BetaToolResultBlockParam => {
      calls.push({ ...call, error: true });
      return { type: "tool_result", tool_use_id: use.id, is_error: true, content: text };
    };
    const tool = Object.values(tools).find((t) => t.id === use.name);
    const simulated = !isSandboxReadTool(use.name);
    if (calls.length >= SANDBOX_MAX_TOOL_CALLS) {
      return fail("Tool call limit reached for this preview turn. Answer with what you have.", { name: use.name, simulated });
    }
    if (!tool?.execute) return fail(`Unknown tool: ${use.name}`, { name: use.name, simulated });
    // Review: a real read runs only with the member's own permission for that data, as in the app
    // (a read tool with no mapped permission is refused: deny by default here too).
    if (!simulated) {
      const needed = READ_TOOL_PERMISSIONS[use.name];
      const allowed = needed ? !this.perm || (await this.perm.viewerCan(workspaceId, viewer, needed)) : false;
      if (!allowed) return fail(`Not allowed: your role cannot read this data (${needed ?? "unmapped tool"}).`, { name: use.name, simulated });
    }
    // Inputs are parsed as JSON (never matched as strings) and validated with the tool's own schema.
    let input: unknown = use.input;
    if (typeof input === "string") {
      try {
        input = JSON.parse(input);
      } catch {
        return fail("Invalid input: not JSON.", { name: use.name, simulated });
      }
    }
    const schema = tool.inputSchema as ZodTypeAny | undefined;
    const parsed = schema ? schema.safeParse(input ?? {}) : { success: true as const, data: input ?? {} };
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`);
      return fail(`Invalid input. ${issues.join("; ")}`.slice(0, 1000), { name: use.name, simulated, args: displayArgs(input) });
    }
    const call: SandboxToolCall = { name: use.name, simulated, args: displayArgs(parsed.data) };
    try {
      const result = await tool.execute(parsed.data as never, {} as never);
      calls.push(call);
      if (use.name === "search_knowledge") sourcesFrom(result, sources);
      const text = JSON.stringify(result ?? null) ?? "null";
      return { type: "tool_result", tool_use_id: use.id, content: text.length > TOOL_RESULT_MAX ? `${text.slice(0, TOOL_RESULT_MAX)}…` : text };
    } catch (e) {
      // Our own service messages (unwrap in the factory); never a stack.
      return fail(String((e as Error)?.message ?? "Tool failed").slice(0, 500), call);
    }
  }
}
