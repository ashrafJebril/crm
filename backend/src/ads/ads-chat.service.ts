import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  adsCampaignStatusEnum,
  insightsLevelEnum,
  adsInsightsBreakdownEnum,
  adsTimeBreakdownEnum,
  type AdsInsightsParams,
  type InsightsLevel,
  type ListCampaignsOptions,
  type AdsLocale,
} from './ads.types';
import { AdsProviderHttpError, type AdsProviderPort } from './ads-provider.port';
import { isUngatedPipeboardTool } from './pipeboard-allowlist';
import { hashAction } from './ads-args-hash';
import { redactArgsForTool } from './ads-redact';
import { extractSpend, approvalWarnJod, spendWarns, type SpendItem } from './ads-spend';
import { createRenderCtx, renderAction, normAccountId, type RenderCtx } from './ads-action-renderers';
import { buildSystemPrompt } from './salma-persona';

const DEFAULT_API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-5'; // override via ADS_CHAT_MODEL
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_TOKENS = 4096;

// Hard caps — the foundation the wallet builds on. Exceeding either aborts the
// loop with an AdsChatLimitError that CARRIES the usage already spent (those
// tokens were billed by Anthropic — the abort path is the high-consumption
// case, so the caller/wallet must still be able to meter them).
const MAX_TOOL_CALLS = 8;
const MAX_ITERATIONS = 6;

// Per-call timeout — the Claude fetch AND each tool call. Normal analysis finishes
// in seconds-to-~30s, so 90s never cuts legitimate work; it caps the ~5-min hang a
// large-context creative turn otherwise takes (undici's default fetch timeout is
// 300s). On breach → AdsChatTimeoutError → a distinct "took too long" reply.
const CALL_TIMEOUT_MS = 90_000;
const ADS_TIMEOUT_REPLY =
  'التحليل أخذ وقت أطول من المتوقع. جرّبي سؤال أضيق (مثلاً فترة أقصر أو حملة وحدة) وبعيدها.';

// Cost guardrail: a breakdown (e.g. hourly × daily) can return ~720 rows.
// Serialized to Claude every loop iteration, the workspace's wallet pays and a
// runaway can hit MAX_TOOL_CALLS before answering. Cap what reaches Claude and
// TELL it when truncated so it never reasons silently on partial data.
const ADS_INSIGHTS_MAX_ROWS = 200;

// ── Overload resilience: ONE shared retry pool per request ──────────────────
// createMessage retries ONLY pre-processing rejections (429 / 529 /
// overloaded_error / rate_limit_error) — never a 4xx that won't fix itself,
// never a network timeout/reject (may have been processed → double charge).
// Backoff is full-jitter exponential PER CALL, but the time budget AND the retry
// count are REQUEST-level: one pool threaded through chat() → createMessage, so
// 6 iterations can't each mint fresh retries. Worst case stays ~5.5s added
// (≈4s backoff + a few fast rejections), independent of iteration count.
const RETRY_BUDGET_MS = 4000;   // total backoff SLEEP the whole request may spend
const MAX_TOTAL_RETRIES = 4;    // total retry attempts across ALL iterations
const RETRY_BASE_MS = 500;      // full-jitter base (per-call exponent)
const RETRY_CAP_MS = 2000;      // cap on any single backoff sleep

interface RetryBudget {
  budgetMs: number; // remaining backoff time the request may still sleep
  left: number;     // remaining retry attempts across the whole request
}

// ── Tool (Pipeboard/Meta) retry pool — SEPARATE from the Claude pool above ──
// A Meta blip must NOT drain Claude-overload protection off a 6-iteration
// request, so tool retries get their OWN per-request pool. Deliberately TIGHTER
// than Claude's: Meta throttles are usually one-shot, so if a couple of short
// retries don't clear it we degrade gracefully (DATA_UNAVAILABLE) instead of
// making the user pay for Meta's bad day. Same jitter shape (RETRY_BASE_MS /
// RETRY_CAP_MS), smaller ceiling.
const TOOL_RETRY_BUDGET_MS = 2000;  // total tool-backoff SLEEP per request
const TOOL_MAX_TOTAL_RETRIES = 3;   // total tool-retry attempts per request

// Full-jitter exponential backoff spent from a SHARED budget — the ONE
// implementation for both the Claude pool (createMessage) and the tool pool
// (runTool). Computes this attempt's sleep, honors Retry-After but never beyond
// the remaining budget, and — when count+time allow — debits the pool and
// sleeps. Returns true if it slept (caller retries) or false if the pool is
// spent (caller raises its own terminal outcome). Even a 0ms jitter consumes
// `left`, so the COUNT cap — not just the time cap — guarantees termination.
async function backoffFromBudget(retry: RetryBudget, attempt: number, retryAfterMs: number | null): Promise<boolean> {
  const ceilMs = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** attempt);
  let delay = Math.floor(Math.random() * ceilMs);
  if (retryAfterMs != null) delay = Math.max(delay, retryAfterMs);
  if (retry.left <= 0 || delay > retry.budgetMs) return false;
  retry.left -= 1;
  retry.budgetMs -= delay;
  await new Promise((r) => setTimeout(r, delay));
  return true;
}

// Stable per-request dedup key: tool name + args with keys SORTED, so a re-call
// with the same args in a different key order still matches (inputs here are
// flat, so a shallow sort suffices). See the `unavailable` set in chat().
function toolKey(name: string, input: any): string {
  const obj = input && typeof input === 'object' ? input : {};
  const sorted = Object.keys(obj).sort().reduce<Record<string, unknown>>((a, k) => { a[k] = obj[k]; return a; }, {});
  return `${name}:${JSON.stringify(sorted)}`;
}

// Degradation payload for a tool whose upstream stayed 429/5xx until the
// request's tool-retry pool was spent. Returned as an is_error tool_result
// (NEVER a 503 — that path is Claude-overload only). The persona already forbids
// guessing on missing data (salma-persona: «لا تخمّني الأرقام» / «إذا البيانات
// ناقصة ... قوليها بوضوح»); this text fires that rule. The "don't re-call" line
// is a HELP; the guarantee is the structural dedup set (`unavailable`).
const DATA_UNAVAILABLE_CONTENT =
  'DATA_UNAVAILABLE: تعذّر جلب البيانات من Meta بعد عدة محاولات (الخدمة مشغولة مؤقتاً). ما في أرقام لهذا الطلب. لا تُقدّري ولا تخمّني أي قيمة، ولا تعيدي استدعاء الأداة الآن — خبّري المستخدم إنك ما قدرتِ تجيبي البيانات هلّق واقترحي إعادة المحاولة بعد شوي.';

// get_ad_creatives prune. A raw creative is ~75% technical BALLAST — signed image/
// video CDN URLs, hashes, dimensions, thumbnails, Advantage+ enhancement specs — the
// model can never use it, yet re-sending it across a per-ad creative loop inflated the
// request ~4x and pushed the creative-analysis turn into Anthropic rate-limit 503s
// (there is no byte cap; capResponse was removed). ROW-PRESERVING: every creative is
// kept, only ballast FIELDS are trimmed. ALL human-readable COPY is preserved — top
// level AND the text nested in object_story_spec / asset_feed_spec — because
// ad_copy_analysis reads it. Unknown shape → forwarded untouched (never lose data).
// This is a field-level trim, NOT the forbidden row-trimming.
function pruneAdCreatives(raw: unknown): unknown {
  const data = (raw as any)?.data;
  if (!Array.isArray(data)) return raw; // unexpected shape → don't touch it
  const s = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
  const texts = (arr: unknown): string[] | undefined => {
    if (!Array.isArray(arr)) return undefined;
    const t = arr.map((x: any) => s(x?.text)).filter(Boolean) as string[];
    return t.length ? t : undefined;
  };
  const pruned = data.map((c: any) => {
    const oss = c?.object_story_spec ?? {};
    const link = oss?.link_data ?? {};
    const video = oss?.video_data ?? {};
    const photo = oss?.photo_data ?? {};
    const afs = c?.asset_feed_spec ?? {};
    const out: Record<string, unknown> = {
      // classification / linkage
      id: s(c?.id),
      name: s(c?.name),
      object_type: s(c?.object_type),
      status: s(c?.status),
      effective_object_story_id: s(c?.effective_object_story_id),
      // human-readable copy — top level
      title: s(c?.title),
      body: s(c?.body),
      message: s(c?.message),
      description: s(c?.description),
      call_to_action_type: s(
        c?.call_to_action_type
        ?? afs?.call_to_actions?.[0]?.type
        ?? afs?.call_to_action_types?.[0]
        ?? link?.call_to_action?.type
        ?? video?.call_to_action?.type,
      ),
      // copy nested in object_story_spec (link / video / photo)
      link_message: s(link?.message),
      link_name: s(link?.name),
      link_description: s(link?.description),
      link_caption: s(link?.caption),
      video_message: s(video?.message),
      video_title: s(video?.title),
      photo_caption: s(photo?.caption),
      // copy nested in asset_feed_spec (Advantage+ multi-text)
      bodies: texts(afs?.bodies),
      titles: texts(afs?.titles),
      descriptions: texts(afs?.descriptions),
    };
    for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
    return out;
  });
  return { ...(raw as any), data: pruned };
}

// The system prompt (Salma's persona + the ads analysis rules) lives in
// ./salma-persona as the single source of truth — buildSystemPrompt(locale,
// timezone) is imported above; the persona CORE is also reused by the cheap gate.

// The tools Claude can see. The three MAPPED reads below are the hot path —
// pruned, Zod-shaped, persona-rule-bound, zero discovery. `pipeboard_call` is the
// passthrough to the other ~106 tools WITHOUT injecting Pipeboard's full catalog
// into the prefix (MEASURED 2026-07-17: the live tools/list is 334KB ≈ 83–95k
// tokens, not the ~55k earlier arithmetic guessed — every message would pay it).
// Writes cannot execute through pipeboard_call: the fail-closed gate in
// dispatchTool returns confirmation_required for anything off PIPEBOARD_UNGATED.
// Enum values come straight from the ./ads.types Zod enums so they never drift.
const ADS_TOOLS = [
  {
    name: 'pipeboard_call',
    description:
      "Call any Meta Ads tool by its exact name to get data or propose a change the three built-in tools don't cover. READ tools (get_*, list_*, search_*, insights, previews, estimates) run immediately and return their data — use this freely for analysis the built-ins miss. WRITE or sensitive tools — create/update/delete/duplicate campaigns, ad sets, ads, creatives, audiences, or rules; and exporting customer contact lists — do NOT run here: they return {status:'confirmation_required'} with a summary of what WOULD happen. On that response: show the summary to the owner, ask her to approve, then STOP — do not retry, and never say the change was made. It runs only after she explicitly approves. The gate is enforced on the server; you cannot talk past it, so don't try. (A list_pipeboard_tools discovery helper for exact names is coming; until then use known Meta Ads tool names.)",
    input_schema: {
      type: 'object',
      properties: {
        tool_name: { type: 'string', description: 'Exact Pipeboard tool name, e.g. get_adsets' },
        args: { type: 'object', description: 'Arguments object for that tool', additionalProperties: true },
      },
      required: ['tool_name'],
    },
  },
  {
    name: 'get_ad_accounts',
    description: 'List the ad accounts this business can access (id, name, currency, status).',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_campaigns',
    description: 'List campaigns for one ad account. Call get_ad_accounts first to get the accountId.',
    input_schema: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: 'Ad account id, e.g. act_123456' },
        status: { type: 'string', enum: [...adsCampaignStatusEnum.options], description: 'Optional status filter' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Max campaigns to return' },
      },
      required: ['accountId'],
    },
  },
  {
    name: 'get_insights',
    description:
      "Performance insights for an ad account. Call get_ad_accounts FIRST to get the real accountId — it is required and has NO default; never guess or invent one (there is no server-side fallback, so a fabricated id just fails a Meta round trip). Per row: spend, impressions, clicks, ctr, cpc, reach, frequency, and THREE INDEPENDENT result counts — chatsStarted (messaging conversations started), leads (contact/form leads), purchases (sales) — each with its own cost field (costPerChat, costPerLead, costPerPurchase). A count and its cost are null when that result type did not fire for the row. ⚠️ The three counts are NOT additive and MUST NEVER be summed: they can OVERLAP — on a messaging campaign a lead is often captured INSIDE a conversation, so those leads are ALREADY included in chatsStarted, and adding them double-counts. The three cost fields are likewise NOT comparable to one another — never sum or average across them. To measure efficiency pick the ONE result that matches the campaign's goal (normally the dominant non-null family) and use its cost: cost per conversation = costPerChat, cost per lead = costPerLead, cost per booking = costPerPurchase. Report each separately; never merge them into a single 'results' or 'conversions' total. When RANKING or RECOMMENDING, IGNORE any row with spend = 0 or an 'Unknown' breakdown value — its cost per result is undefined and misleading, so it must never top a 'cheapest' ranking; surface it only as a data-quality note. Provide either datePreset OR both since & until. Optionally segment with breakdown and/or timeBreakdown — this returns ONE ROW PER SEGMENT and NO overall total row, so OMIT both when you only need totals.",
    input_schema: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: 'Real ad account id from get_ad_accounts (format act_<digits>). Required — no default; never guess or invent one.' },
        level: { type: 'string', enum: [...insightsLevelEnum.options], description: "Aggregation level (default 'account')" },
        datePreset: { type: 'string', description: "Meta preset, e.g. 'last_30d', 'this_month'" },
        since: { type: 'string', description: 'YYYY-MM-DD (use together with until)' },
        until: { type: 'string', description: 'YYYY-MM-DD (use together with since)' },
        breakdown: { type: 'string', enum: [...adsInsightsBreakdownEnum.options], description: 'Segment results by one dimension (age, region, publisher_platform, hourly_stats_aggregated_by_advertiser_time_zone, …). Omit for totals.' },
        timeBreakdown: { type: 'string', enum: [...adsTimeBreakdownEnum.options], description: 'Segment over time (day/week/month). Combinable with breakdown.' },
      },
      required: ['accountId'],
    },
  },
] as const;

// ── Local types (no contracts change this phase) ────────────────────────────
// Loop/turn shape (content may hold tool_use/tool_result blocks) — distinct from
// the persisted ./ads.types AdsChatMessageDto (content: string). The
// controller phase will adopt that DTO and drop this local interface.
export interface AdsChatTurn {
  role: 'user' | 'assistant';
  content: string | any[]; // plain text or Anthropic content blocks
}

export interface AdsChatUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface AdsChatToolCall {
  name: string;
  input: unknown;
}

/**
 * A gated pipeboard_call that the gate REFUSED to execute. The gate mints it
 * (action_id + args_hash) purely — no DB here (AdsChatService stays stateless) —
 * and returns it in AdsChatResult so the SESSION service persists it as an
 * AdsPendingAction. Nothing here executes; execution is the approve endpoint's.
 */
export interface PendingProposal {
  actionId: string;
  tool: string;
  args: Record<string, unknown>;
  argsHash: string;
  summary: string;
  summaryIsPlaceholder: boolean;
}

export interface AdsChatResult {
  reply: string;                 // final assistant text
  newMessages: AdsChatTurn[];    // messages produced this turn (assistant + tool_result turns)
  toolCalls: AdsChatToolCall[];  // tools executed this turn (audit/debug)
  proposals: PendingProposal[];  // gated actions to persist (never executed here)
  usage: AdsChatUsage;           // accumulated across every iteration — the wallet meters this later
  stopReason: string;
}

/**
 * Thrown when a guardrail cap is hit mid-loop. Carries the usage ALREADY spent
 * (and billed) plus the tool calls made so far, so the caller/wallet can meter
 * partial consumption instead of dropping it — abort is the high-spend path.
 */
export class AdsChatLimitError extends Error {
  constructor(
    message: string,
    readonly limit: 'MAX_TOOL_CALLS' | 'MAX_ITERATIONS',
    readonly usage: AdsChatUsage,
    readonly toolCalls: AdsChatToolCall[],
  ) {
    super(message);
    this.name = 'AdsChatLimitError';
  }
}

/**
 * Thrown when Anthropic stays overloaded (429 / 529 / overloaded_error) until the
 * request's SHARED retry pool is spent. The controller maps it to
 * AdsServiceBusyException (503, ADS_SERVICE_BUSY) so the web shows a distinct
 * "busy — try again" state instead of a bare 500. Carries NO usage: like any
 * generic failure it takes postMessage's `throw err` path — nothing persisted,
 * nothing debited, wallet untouched.
 */
export class AdsChatOverloadedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdsChatOverloadedError';
  }
}

/**
 * Thrown when a Claude fetch or a single tool call exceeds CALL_TIMEOUT_MS. Caught
 * inside chat() and turned into a DISTINCT "took too long" REPLY (not the busy 503),
 * so a hung/slow turn returns a clear message in ~90s instead of hanging ~5 min.
 */
export class AdsChatTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdsChatTimeoutError';
  }
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Retry-After is either delta-seconds (integer) or an HTTP-date. Returns ms to
// wait, or null when absent/unparseable.
function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(header);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

function extractText(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b: any) => b?.type === 'text')
    .map((b: any) => b.text)
    .join('\n')
    .trim();
}

// Interim honest fallback for a gated action that has NO machine renderer yet
// (renderers land STEP 5). It shows the tool name + its args verbatim and a bold
// warning, so a UI wired against this envelope BEFORE STEP 5 cannot present a bare
// tool name as if it were a described action — that would be manufactured consent.
// The envelope also carries summary_is_placeholder:true, the contract STEP 3's
// approve endpoint uses to REFUSE executing any action whose summary was never
// rendered. Each arg value is capped so a large/raw payload can't bloat the card.
function renderFallbackSummary(
  toolName: string,
  args: Record<string, unknown>,
  spend: SpendItem[],
  spendWarn: boolean,
  warnJod: number,
): string {
  const keys = Object.keys(args);
  const body = keys.length
    ? keys
        .map((k) => {
          const v = args[k];
          const s = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
          return `  • ${k}: ${s.length > 200 ? s.slice(0, 200) + '…' : s}`;
        })
        .join('\n')
    : '  (بدون وسائط)';
  // Spend surfaced PROMINENTLY at the top, with a large-amount warning so a big
  // budget never looks like a small one on the confirmation card.
  const spendBlock = spend.length
    ? (spendWarn
        ? `🔴 مبلغ كبير — راجع بعناية قبل الموافقة (الحد التحذيري ≈ ${warnJod} د.أ):\n`
        : '💰 مبالغ متعلّقة بالصرف:\n') +
      spend.map((s) => `  • ${s.field}: ${s.minorValue} (قيمة خام بوحدة العملة الصغرى — بدون تحويل)`).join('\n') +
      '\n'
    : '';
  return (
    `إجراء يحتاج موافقة المالك: «${toolName}»\n` +
    spendBlock +
    `الوسائط:\n${body}\n` +
    '⚠️ لا يوجد وصف مبسّط لهذا الإجراء بعد — راجع التفاصيل بعناية قبل الموافقة.'
  );
}

/**
 * Returns a shallow COPY of `messages` in which the newest tool_result block
 * carries an ephemeral cache_control breakpoint — the read anchor for the whole
 * accumulated prefix. `messages` (the caller's append-only `working`) is never
 * mutated: only the one target message, its content array, and the one target
 * block are cloned; everything else is shared by reference (it's about to be
 * serialized). Called fresh each hop, so the breakpoint always sits on the
 * current last tool_result and nothing stale persists → never exceeds the
 * API's 4-breakpoint cap (this + system = 2). Turns with no tool_result yet
 * (0-call turns, iteration 0) return `messages` unchanged (system bp only).
 */
function withRollingToolResultCache(messages: any[]): any[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i]?.content;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      if (content[j]?.type !== 'tool_result') continue;
      const block = { ...content[j], cache_control: { type: 'ephemeral' } };
      const newContent = content.slice();
      newContent[j] = block;
      const out = messages.slice();
      out[i] = { ...messages[i], content: newContent };
      return out;
    }
  }
  return messages;
}

/**
 * Read-only Ads Assistant chat engine. Runs a curated Claude tool-use loop over
 * the AdsProviderPort. Stateless (caller owns history); read-only (only the
 * three read tools exist). Credentials come via the CONSTRUCTOR (env fallback),
 * same isolation pattern as PipeboardProvider — Phase 3's per-workspace factory
 * will build one of these per workspace with that workspace's provider + key.
 */
@Injectable()
export class AdsChatService {
  private readonly cfgApiKey?: string;
  private readonly apiUrl: string;
  // public: the session service reads the model ACTUALLY used for the wallet
  // debit breakdown, so the string isn't duplicated.
  readonly model: string;

  constructor(
    private readonly provider: AdsProviderPort,
    cfg?: { apiKey?: string },
  ) {
    // Resolve the key LAZILY (resolveApiKey) so a missing ANTHROPIC_API_KEY
    // fails the REQUEST with a clear error, not API boot when the module is
    // DI-instantiated. Per-instance cfg is preserved.
    this.cfgApiKey = cfg?.apiKey;
    this.apiUrl = process.env.ANTHROPIC_API_URL ?? DEFAULT_API_URL;
    this.model = process.env.ADS_CHAT_MODEL ?? DEFAULT_MODEL;
  }

  private resolveApiKey(): string {
    const k = this.cfgApiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!k) {
      throw new Error('AdsChatService: no API key (pass cfg.apiKey or set ANTHROPIC_API_KEY)');
    }
    return k;
  }

  /**
   * Run one assistant turn. `messages` is the full prior history INCLUDING the
   * latest user message. Returns the reply plus every message produced this
   * turn (so the caller can persist), the tools executed, and accumulated usage.
   */
  async chat(messages: AdsChatTurn[], locale: AdsLocale = 'ar', timezone = 'Asia/Amman'): Promise<AdsChatResult> {
    if (!messages.length) throw new Error('AdsChatService: messages is empty');

    const working: any[] = messages.map((m) => ({ role: m.role, content: m.content }));
    const newMessages: AdsChatTurn[] = [];
    const toolCalls: AdsChatToolCall[] = [];
    // Gated proposals produced this turn. Request-local (like `toolCalls`), so two
    // concurrent chats never share a collector. Returned for the session service to
    // persist as AdsPendingAction rows. Never executed here.
    const proposals: PendingProposal[] = [];
    // Per-request render context: memoized ALLOWLISTED reads (account currency, entity
    // details) that make the proposal summaries currency-honest, shared across every
    // gated proposal this turn so they don't re-fetch. See ads-action-renderers
    // INVARIANT NOTE — reads on the propose path, never a gated write.
    const renderCtx = createRenderCtx(this.provider);
    const usage: AdsChatUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    };
    let totalToolCalls = 0;

    // PER-REQUEST retry pool. chat() runs once per postMessage (per HTTP
    // request); `retry` is a plain local on this invocation's stack, so two
    // concurrent users get INDEPENDENT pools — neither can drain the other's.
    // Threaded into every createMessage so the whole tool loop shares ONE budget.
    const retry: RetryBudget = { budgetMs: RETRY_BUDGET_MS, left: MAX_TOTAL_RETRIES };

    // SEPARATE per-request tool-retry pool (Meta/Pipeboard), isolated from the
    // Claude `retry` above — a Meta blip must not drain Claude-overload
    // protection. Same stack-local scoping, so concurrent requests stay
    // independent. Threaded into every runTool.
    const toolRetry: RetryBudget = { budgetMs: TOOL_RETRY_BUDGET_MS, left: TOOL_MAX_TOTAL_RETRIES };
    // Per-request dedup guard. Holds toolKey(name,args) for every call that has
    // already exhausted the pool and returned DATA_UNAVAILABLE. An identical
    // re-call short-circuits to the SAME cached result — no HTTP, no retry, no
    // wait — so the model can't hammer a dead upstream even if it ignores the
    // prompt-level "don't re-call" line. (It's still one tool_use, so it still
    // counts toward MAX_TOOL_CALLS — the counter sits above runTool and stays
    // deliberately untouched; only the wasted HTTP/retry/wait is eliminated.)
    const unavailable = new Set<string>();

    // Timeout guard: a Claude or tool call over CALL_TIMEOUT_MS throws
    // AdsChatTimeoutError; caught below → returned as a clear "took too long" reply
    // instead of a ~5-min hang / generic busy 503. MAX_ITERATIONS & others rethrow.
    try {
    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      const res = await this.createMessage(working, locale, timezone, retry);

      usage.inputTokens += num(res?.usage?.input_tokens);
      usage.outputTokens += num(res?.usage?.output_tokens);
      usage.cacheReadInputTokens += num(res?.usage?.cache_read_input_tokens);
      usage.cacheCreationInputTokens += num(res?.usage?.cache_creation_input_tokens);

      // Echo the assistant turn back verbatim (preserves tool_use / any thinking).
      const assistantMsg: AdsChatTurn = { role: 'assistant', content: res?.content ?? [] };
      working.push(assistantMsg);
      newMessages.push(assistantMsg);

      if (res?.stop_reason !== 'tool_use') {
        return { reply: extractText(res?.content), newMessages, toolCalls, proposals, usage, stopReason: res?.stop_reason ?? 'unknown' };
      }

      const toolUses = (Array.isArray(res.content) ? res.content : []).filter((b: any) => b?.type === 'tool_use');
      if (toolUses.length === 0) {
        return { reply: extractText(res?.content), newMessages, toolCalls, proposals, usage, stopReason: res?.stop_reason };
      }

      const results: any[] = [];
      for (const tu of toolUses) {
        totalToolCalls++;
        if (totalToolCalls > MAX_TOOL_CALLS) {
          throw new AdsChatLimitError(
            `AdsChatService: exceeded MAX_TOOL_CALLS (${MAX_TOOL_CALLS})`,
            'MAX_TOOL_CALLS',
            usage,
            toolCalls,
          );
        }
        toolCalls.push({ name: tu.name, input: tu.input });
        // 90s guard per tool call. On breach we throw AdsChatTimeoutError (surfaced as
        // the "took too long" reply); the underlying runTool keeps running in the
        // background (its socket lingers until undici's default — accepted), so we
        // swallow its late rejection to avoid an unhandledRejection.
        const toolCall = this.runTool(tu.name, tu.input, toolRetry, unavailable, proposals, renderCtx);
        toolCall.catch(() => {});
        let toolTimer: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          toolCall,
          new Promise<never>((_, reject) => {
            toolTimer = setTimeout(
              () => reject(new AdsChatTimeoutError(`Tool ${tu.name} exceeded ${CALL_TIMEOUT_MS}ms`)),
              CALL_TIMEOUT_MS,
            );
          }),
        ]).finally(() => clearTimeout(toolTimer));
        results.push({ type: 'tool_result', tool_use_id: tu.id, ...result });
      }

      // All tool_results go back in ONE user message.
      const toolMsg: AdsChatTurn = { role: 'user', content: results };
      working.push(toolMsg);
      newMessages.push(toolMsg);
    }

    throw new AdsChatLimitError(
      `AdsChatService: exceeded MAX_ITERATIONS (${MAX_ITERATIONS}) without end_turn`,
      'MAX_ITERATIONS',
      usage,
      toolCalls,
    );
    } catch (e) {
      if (e instanceof AdsChatTimeoutError) {
        // Distinct from the overloaded/busy 503: return the timeout note AS Salma's
        // reply so the user sees a clear message, not a hang. (200, not a toast.)
        return { reply: ADS_TIMEOUT_REPLY, newMessages, toolCalls, proposals, usage, stopReason: 'timeout' };
      }
      throw e;
    }
  }

  // Curated tool dispatch — READ ONLY. Transient upstream failures (Meta 429/5xx,
  // signaled by the port's AdsProviderHttpError) are retried from the request's
  // SEPARATE tool-retry pool; a call that stays down until the pool is spent
  // degrades to an is_error DATA_UNAVAILABLE result (NEVER a 503), so Claude can
  // tell the user plainly instead of the whole turn dying. `unavailable` is the
  // per-request dedup set: once a (tool+args) call has returned DATA_UNAVAILABLE,
  // an identical re-call returns the SAME result with no HTTP/retry/wait.
  private async runTool(
    name: string,
    input: any,
    toolRetry: RetryBudget,
    unavailable: Set<string>,
    proposals: PendingProposal[],
    renderCtx: RenderCtx,
  ): Promise<{ content: string; is_error?: true }> {
    const key = toolKey(name, input);
    if (unavailable.has(key)) return { content: DATA_UNAVAILABLE_CONTENT, is_error: true };

    for (let attempt = 0; ; attempt++) {
      try {
        return await this.dispatchTool(name, input, proposals, renderCtx);
      } catch (e: any) {
        // Retry ONLY transient upstream HTTP (429/5xx). Everything else — 4xx,
        // JSON-RPC 200-errors, tool isError, schema/parse failures — is terminal
        // and surfaced as is_error immediately (unchanged behaviour).
        if (!(e instanceof AdsProviderHttpError) || !(e.status === 429 || e.status >= 500)) {
          return { content: `Tool ${name} failed: ${e?.message ?? String(e)}`, is_error: true };
        }
        const retried = await backoffFromBudget(toolRetry, attempt, parseRetryAfterMs(e.retryAfter));
        if (!retried) {
          // Pool spent → degrade gracefully AND remember this exact call so an
          // identical re-call this request short-circuits above (no HTTP/wait).
          unavailable.add(key);
          return { content: DATA_UNAVAILABLE_CONTENT, is_error: true };
        }
      }
    }
  }

  // Pure dispatch — the read-only switch. Throws on provider failure (caller
  // classifies + retries); returns is_error only for an unknown tool name.
  private async dispatchTool(name: string, input: any, proposals: PendingProposal[], renderCtx: RenderCtx): Promise<{ content: string; is_error?: true }> {
    switch (name) {
      case 'pipeboard_call':
        return this.pipeboardCall(input, proposals, renderCtx);
      case 'get_ad_accounts': {
        const accounts = await this.provider.getAdAccounts();
        return { content: JSON.stringify(accounts) };
      }
      case 'get_campaigns': {
        const opts: ListCampaignsOptions = { status: input?.status, limit: input?.limit };
        const campaigns = await this.provider.getCampaigns(String(input?.accountId ?? ''), opts);
        // hasMore rides on the array (withHasMore). If Meta has another page, tell
        // Claude explicitly so a campaign ranking never implies completeness.
        const more = (campaigns as any).hasMore === true;
        return { content: JSON.stringify(
          more
            ? { campaigns, truncated: true, shown: campaigns.length,
                note: `Showing ${campaigns.length} campaigns but MORE exist — a PARTIAL set. When ranking, say you ranked the top/bottom of more; narrow by status for the full list.` }
            : { campaigns, truncated: false },
        ) };
      }
      case 'get_insights': {
        const params: AdsInsightsParams = {
          level: (input?.level as InsightsLevel) ?? 'account',
          datePreset: input?.datePreset,
          since: input?.since,
          until: input?.until,
          breakdown: input?.breakdown,
          timeBreakdown: input?.timeBreakdown,
        };
        const accountId = String(input?.accountId ?? '');
        const rows = await this.provider.getInsights(accountId, params);
        // Account currency attached ONCE to the envelope (never per row — it's an account
        // property, not a row property). Reuses renderCtx's memoized getAdAccounts, so the
        // write-card path and this share ONE fetch per request. null when unresolvable →
        // the persona has Salma say she couldn't determine it rather than guess a symbol.
        const currency = await renderCtx.currencyForAccount(normAccountId(accountId));
        const more = (rows as any).hasMore === true; // Meta had another page beyond what we fetched
        if (rows.length > ADS_INSIGHTS_MAX_ROWS || more) {
          const shown = rows.slice(0, ADS_INSIGHTS_MAX_ROWS);
          const total = more ? `more than ${rows.length}` : `${rows.length}`;
          return { content: JSON.stringify({
            rows: shown, truncated: true, shown: shown.length, total, currency,
            note: `Showing the first ${ADS_INSIGHTS_MAX_ROWS} of ${total} rows — a PARTIAL set. When ranking, say the top/bottom of ${total}; narrow the date range or breakdown for complete data.`,
          }) };
        }
        return { content: JSON.stringify({ rows, truncated: false, currency }) };
      }
      default:
        return { content: `Unknown tool: ${name}`, is_error: true };
    }
  }

  // ── THE GATE ────────────────────────────────────────────────────────────
  // The single chokepoint for the passthrough, and the only thing between a
  // prompt injection and a real campaign. Fail-closed:
  //
  //   tool_name ∈ PIPEBOARD_UNGATED   → benign read → execute via callRaw
  //   tool_name ∉ PIPEBOARD_UNGATED   → write OR consequential read OR a tool
  //                                     Pipeboard shipped that we've never seen
  //                                     → NEVER reaches callRaw here; returns a
  //                                       confirmation_required proposal instead.
  //
  // The critical invariant, verifiable by eye: the `return` in the gated branch
  // sits BEFORE any provider call, so an unrecognized or write tool_name cannot
  // execute in the tool loop. Execution of a gated tool happens ONLY in the
  // ads.view-guarded approve endpoint (STEP 3), never here.
  private async pipeboardCall(input: any, proposals: PendingProposal[], renderCtx: RenderCtx): Promise<{ content: string; is_error?: true }> {
    const toolName = typeof input?.tool_name === 'string' ? input.tool_name.trim() : '';
    const args = input?.args && typeof input.args === 'object' ? (input.args as Record<string, unknown>) : {};

    if (!toolName) {
      return { content: 'pipeboard_call requires a tool_name string.', is_error: true };
    }

    // ── GATED: not on the allowlist → propose, do NOT execute ───────────────
    if (!isUngatedPipeboardTool(toolName)) {
      // Mint the proposal PURELY (no DB — AdsChatService stays stateless): an
      // action_id the owner will approve by, and an args_hash freezing exactly
      // these args. The session service persists it as a PENDING AdsPendingAction;
      // the approve endpoint is the only code that executes it. STEP 5 replaces the
      // fallback summary with an args-faithful rendering and flips
      // summary_is_placeholder to false — until then true tells the approve
      // endpoint to REFUSE (never approve an un-rendered action). The invariant
      // that matters: no provider call is reachable below this return.
      const actionId = randomUUID();
      // The RAW args ride the proposal (→ argsJson, what actually executes) and the
      // hash binds {tool, raw args}. The summary and the model-facing echo use the
      // REDACTED view so customer PII never lands in the fallback summary, the audit,
      // or the model's context — only in the operational argsJson the write needs.
      const shownArgs = redactArgsForTool(toolName, args) as Record<string, unknown>;
      // Spend detection on RAW args (budgets aren't PII); drives the envelope's
      // spend_warn. The DTO mapper recomputes it from the persisted argsJson.
      const spend = extractSpend(args);
      const warnJod = approvalWarnJod();
      const spendWarn = spendWarns(spend, warnJod);
      // STEP 5: machine-render a currency-honest, args-faithful summary from the
      // REDACTED args (no PII). renderAction FETCHES the real account currency
      // (allowlisted reads on the propose path — see ads-action-renderers INVARIANT
      // NOTE) and returns isPlaceholder=true for any tool without a renderer or any
      // amount whose currency can't be resolved. On placeholder we fall back to the
      // interim text and KEEP summary_is_placeholder=true, so the approve endpoint AND
      // the card's موافق stay closed. Never a guessed number / symbol / /100 estimate.
      const rendered = await renderAction(renderCtx, toolName, shownArgs);
      const summaryIsPlaceholder = rendered.isPlaceholder;
      const summary = summaryIsPlaceholder
        ? (rendered.summary || renderFallbackSummary(toolName, shownArgs, spend, spendWarn, warnJod))
        : rendered.summary;
      // hashAction is widened to bind the SUMMARY: the shown text is now sealed to
      // {tool, args}. The approve endpoint re-checks the same triple, so a rendered-vs-
      // executed or tampered-summary mismatch is refused.
      proposals.push({ actionId, tool: toolName, args, argsHash: hashAction(toolName, args, summary), summary, summaryIsPlaceholder });
      return {
        content: JSON.stringify({
          status: 'confirmation_required',
          action_id: actionId,
          tool: toolName,
          args: shownArgs,
          summary,
          summary_is_placeholder: summaryIsPlaceholder,
          spend_relevant: spend.map((s) => ({ field: s.field, value: s.minorValue })),
          spend_warn: spendWarn,
          spend_warn_threshold_jod: warnJod,
          note: summaryIsPlaceholder
            ? 'This action was NOT executed and its summary is not machine-rendered yet — it is NOT approvable. Present it and tell the owner it needs a clearer description first; do not retry.'
            : "This action was NOT executed. It needs the account owner to approve it (via the card) before it runs. Present the summary and STOP; do not retry, and never say it was done.",
        }),
      };
    }

    // ── UNGATED: benign read → passthrough execute ──────────────────────────
    // The raw parsed payload is forwarded as-is, EXCEPT get_ad_creatives, which is
    // field-pruned first (pruneAdCreatives): its raw form is ~75% technical ballast
    // (signed media URLs, hashes, dimensions, enhancement specs) that inflated the
    // creative-analysis turn into Anthropic rate-limit 503s. The prune is ROW-PRESERVING
    // (every creative kept, only ballast FIELDS trimmed) and keeps all copy text.
    // STEP 6 still owes the PII redaction denylist here (get_account_activities actor
    // names, etc.). NO byte ceiling and NO row-trimming — every response arrives complete.
    const raw = await this.provider.callRaw(toolName, args);
    const forwarded = toolName === 'get_ad_creatives' ? pruneAdCreatives(raw) : raw;
    return { content: JSON.stringify(forwarded) };
  }

  private async createMessage(messages: any[], locale: AdsLocale, timezone: string, retry: RetryBudget): Promise<any> {
    const requestBody = JSON.stringify({
      model: this.model,
      max_tokens: MAX_TOKENS,
      // Cache the stable prefix. The breakpoint sits on the system block; the
      // API caches everything before it in canonical order (tools → system),
      // so ADS_TOOLS is covered too. Measured prefix (ar, current 3 tools) =
      // 3778 tokens — harness cache_creation_input_tokens, 2026-07-17; en not
      // re-measured this run (the old ≈2168/2652 figures were stale by ~1600 and
      // are removed rather than replaced with another guess). Comfortably over the
      // ephemeral-cache floor (1024, or 2048 on stricter Sonnet-family), so it
      // actually caches. First iteration writes at 1.25x; every later iteration/turn
      // (within the read-refreshed 5-min TTL) reads it back at 0.10x. If ADS_TOOLS
      // changes, re-measure via measure-salma.js section (0) — do NOT estimate.
      system: [{ type: 'text', text: buildSystemPrompt(locale, timezone), cache_control: { type: 'ephemeral' } }],
      tools: ADS_TOOLS,
      // Rolling breakpoint on the newest tool_result — the READ ANCHOR for the
      // whole accumulated message prefix, so every re-sent tool_result from
      // earlier hops reads back at 0.10x instead of paying 1.0x again. Applied
      // at SEND-time on a clone, NOT stored in `working`, so it "moves" for free:
      // each hop marks only the current last tool_result and nothing stale ever
      // persists (working is append-only, :314/:344). 2 of 4 slots (system + 1);
      // accumulating hit the API's 4-block cap (measured: 5 → 400), so we MOVE.
      // Always set (no size/turn-shape gate): withholding it strands the biggest
      // hop uncached. Measured on 44 real turns — 70% of tool-using turns are
      // multi-fetch (win); the only cost is +25% on a single-fetch turn's
      // terminal result (~3.7K tok / ~0.016 JOD), dwarfed ~11x by the analysis
      // win. Mechanism proven in measure-salma-cache.ts §B (14,842 tok → 0.10x).
      messages: withRollingToolResultCache(messages),
    });

    // NOTE: no request timeout yet — a hung socket blocks indefinitely. This is
    // the PRE-EXISTING status quo, NOT a regression from the retry work. We do
    // NOT guess an AbortController value: too short kills a legitimate slow
    // analysis generation, and a per-attempt timeout gives no per-request bound
    // anyway. Set it from the harness p99 of a HEALTHY createMessage once
    // Anthropic is no longer overloaded (see the 529 plan). Until then: unbounded.
    for (let attempt = 0; ; attempt++) {
      let res: any;
      let raw = '';
      try {
        res = await fetch(this.apiUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': this.resolveApiKey(),
            'anthropic-version': ANTHROPIC_VERSION,
          },
          body: requestBody,
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS), // per-attempt 90s cap (vs undici's 300s default)
        });
        raw = await res.text();
      } catch (e: any) {
        // Hung/slow Claude socket → abort at CALL_TIMEOUT_MS and rethrow as a DISTINCT
        // error the loop surfaces as a clear "took too long" reply — not the busy path.
        if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
          throw new AdsChatTimeoutError(`Claude API call exceeded ${CALL_TIMEOUT_MS}ms`);
        }
        throw e;
      }
      let body: any = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }

      // Success.
      if (res.ok && body?.type !== 'error') return body;

      const errType: string | undefined = body?.error?.type;
      const detail = res.ok
        ? `error ${errType ?? 'unknown'}: ${body?.error?.message ?? ''}`
        : `HTTP ${res.status}: ${raw.slice(0, 300)}`;

      // Retry ONLY pre-processing rejections (zero tokens billed). A 4xx that
      // won't fix itself (400/401/403/404/422…) and any other error fail now —
      // unchanged behaviour → generic 500 for everything except overload.
      const retryable =
        res.status === 429 || res.status === 529 ||
        errType === 'overloaded_error' || errType === 'rate_limit_error';
      if (!retryable) throw new Error(`Anthropic API ${detail}`);

      // Spend from the SHARED per-request Claude pool via the shared backoff
      // helper (full-jitter exponential, Retry-After capped by remaining budget).
      const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
      const retried = await backoffFromBudget(retry, attempt, retryAfterMs);
      if (!retried) {
        throw new AdsChatOverloadedError(`Anthropic overloaded, retry budget spent (${detail})`);
      }
    }
  }
}
