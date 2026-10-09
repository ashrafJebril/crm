import { Injectable } from '@nestjs/common';
import {
  adAccountSchema,
  adsCampaignSchema,
  adsInsightsSchema,
  adsCampaignStatusEnum,
  type AdAccount,
  type AdsCampaign,
  type AdsInsights,
  type AdsCampaignStatus,
  type AdsInsightsParams,
  type ListCampaignsOptions,
} from './ads.types';
import { AdsProviderHttpError, type AdsProviderPort, type RawToolDescriptor } from './ads-provider.port';

const DEFAULT_MCP_URL = 'https://meta-ads.mcp.pipeboard.co/';

// Explicit page sizes — MUST be sent. Omitting the limit inherited Meta's tiny
// defaults (get_insights 25, get_campaigns 10) and silently returned page 1:
// get_insights gave 25 of 40 ads, get_campaigns 50 of 107 — both with truncated
// absent, so every ranking analyzed a partial set as if whole. MEASURED, not
// guessed: the probe proved get_insights accepts limit=250 (all 40 rows, no error;
// schema declares no max) and get_campaigns accepts limit=500 (all 107). 250 sits
// ABOVE the tool-layer forward cap (ADS_INSIGHTS_MAX_ROWS=200) so that cap fires
// HONESTLY for >200-item accounts instead of never firing; beyond 250, the
// paging.next signal (see withHasMore) drives the truncation note.
const INSIGHTS_FETCH_LIMIT = 250;
const CAMPAIGNS_FETCH_LIMIT = 250;

// Attach Meta's "there's another page" signal to the returned array WITHOUT
// changing the port's array shape. paging.next is present ONLY when a next page
// exists — cursors.after is present even on a COMPLETE response (measured), so it
// is NOT a hasMore signal (building on it would loop forever). The flag rides on
// the array object; JSON.stringify of an array ignores non-index props, so it
// never leaks into a tool payload — the tool layer reads (rows as any).hasMore.
function withHasMore<T>(rows: T[], raw: any): T[] {
  (rows as any).hasMore = !!raw?.paging?.next;
  return rows;
}

// Meta numeric account_status → label.
const ACCOUNT_STATUS: Record<number, string> = {
  1: 'ACTIVE', 2: 'DISABLED', 3: 'UNSETTLED', 7: 'PENDING_RISK_REVIEW',
  8: 'PENDING_SETTLEMENT', 9: 'IN_GRACE_PERIOD', 100: 'PENDING_CLOSURE',
  101: 'CLOSED', 201: 'ANY_ACTIVE', 202: 'ANY_CLOSED',
};

function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : fallback;
}

function campaignStatus(raw: any): AdsCampaignStatus {
  const s = String(raw?.status ?? raw?.effective_status ?? '').toUpperCase();
  const parsed = adsCampaignStatusEnum.safeParse(s);
  return parsed.success ? parsed.data : 'UNKNOWN';
}

// Meta reports the SAME underlying result under many action_type labels
// (onsite/offsite/grouped/standard-event aliases). A flat sum double-counts —
// `lead` + `lead_grouped` counts the same leads twice. So we group labels into
// FAMILIES and, within each, take the value of the FIRST alias PRESENT in
// priority order (canonical/deduped first, most-specific last). The three family
// counts are kept SEPARATE and never summed: a `lead` may already be inside a
// messaging conversation, so adding them would re-introduce that double-count.
const MESSAGING_ORDER = [
  'onsite_conversion.messaging_conversation_started_7d',
] as const;
const LEAD_ORDER = [
  'onsite_conversion.lead_grouped',               // Meta's canonical unified "Leads"
  'lead',                                         // classic aggregate
  'onsite_conversion.lead',
  'onsite_web_lead',
  'offsite_conversion.fb_pixel_lead',
  'offsite_complete_registration_add_meta_leads', // instant-form standard-event aliases
  'offsite_submit_application_add_meta_leads',
  'offsite_search_add_meta_leads',
  'offsite_content_view_add_meta_leads',
  'offsite_contact_website_add_meta_leads',
] as const;
const PURCHASE_ORDER = [
  'omni_purchase',                                // cross-surface total (already deduped)
  'purchase',
  'offsite_conversion.fb_pixel_purchase',
  'onsite_conversion.purchase',
  'onsite_web_purchase',
  'onsite_app_purchase',
  'onsite_web_app_purchase',
] as const;

// Value of the first action_type in `order` present in `actions`, else null.
// null (not 0) = the family did not fire; a real "fired but zero" keeps 0.
function firstPresent(actions: any, order: readonly string[]): number | null {
  if (!Array.isArray(actions)) return null;
  for (const type of order) {
    const hit = actions.find((a) => String(a?.action_type) === type);
    if (hit) return num(hit.value);
  }
  return null;
}

// Round to 4 decimals — LOCAL, deliberately NOT the payroll-guarded round2.
// Costs are born rounded so a raw 16-digit float never reaches Claude per row.
function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

// Cost per result: spend / count, rounded; null when the count is null or ≤ 0.
function costPer(spend: number, count: number | null): number | null {
  return count != null && count > 0 ? round4(spend / count) : null;
}

/**
 * Prototype AdsProviderPort backed by Pipeboard's remote Meta-Ads MCP server
 * over Streamable HTTP (JSON-RPC 2.0). Read-only: write methods are not
 * implemented in this phase.
 *
 * Credentials come in via the CONSTRUCTOR (never read from a process-wide
 * singleton at call time). Phase 3 introduces an AdsProviderFactory that returns
 * a PER-TENANT instance built with that tenant's token — the per-tenant token IS
 * the Model A isolation boundary. `sessionId`/`nextId` are instance state, so
 * each per-tenant instance gets its OWN MCP session; nothing is shared across
 * tenants. The AdsProviderPort signature must NOT change to carry
 * tenant/credentials — isolation lives in which instance you hold, not in args.
 */
@Injectable()
export class PipeboardProvider implements AdsProviderPort {
  private readonly cfgToken?: string;
  private readonly url: string;
  private sessionId?: string;
  private nextId = 1;

  constructor(cfg?: { token?: string; mcpUrl?: string }) {
    // Resolve the token LAZILY (resolveToken) so a missing token fails the
    // REQUEST with a clear error, not API boot when the module is
    // DI-instantiated. Per-tenant isolation is unchanged — the instance still
    // carries its own cfg.token (env is only the dev fallback).
    this.cfgToken = cfg?.token;
    this.url = cfg?.mcpUrl ?? process.env.PIPEBOARD_MCP_URL ?? DEFAULT_MCP_URL;
  }

  private resolveToken(): string {
    const t = this.cfgToken ?? process.env.PIPEBOARD_TOKEN;
    if (!t) {
      throw new Error('PipeboardProvider: no token (pass cfg.token or set PIPEBOARD_TOKEN)');
    }
    return t;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.resolveToken()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId;
    return h;
  }

  private parseBody(contentType: string, raw: string): any {
    if (contentType.includes('text/event-stream')) {
      const dataLines = raw
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim());
      for (const d of dataLines) {
        try {
          const m = JSON.parse(d);
          if (m && (m.result !== undefined || m.error !== undefined || m.jsonrpc)) return m;
        } catch { /* keep scanning */ }
      }
      try { return JSON.parse(dataLines.join('')); }
      catch { throw new Error(`Unparseable SSE from Pipeboard MCP: ${raw.slice(0, 200)}`); }
    }
    return raw ? JSON.parse(raw) : {};
  }

  private async rpc(method: string, params: unknown): Promise<any> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    const raw = await res.text();
    if (!res.ok) {
      // Typed so the agent layer classifies transient (429/5xx) vs terminal and
      // OWNS the retry — this provider stays retry-free, so a future NON-idempotent
      // write path (proposeCampaign/confirmCreate/activate) can't silently inherit
      // a retry and double-spend on an ambiguous failure. Retry-After passed through.
      throw new AdsProviderHttpError(
        `Pipeboard MCP HTTP ${res.status} on ${method}: ${raw.slice(0, 300)}`,
        res.status,
        res.headers.get('retry-after'),
      );
    }
    return this.parseBody(res.headers.get('content-type') || '', raw);
  }

  // Some Streamable-HTTP servers require an initialize handshake + session
  // before tools/call; others accept a bare token-authed tools/call. We try the
  // direct call and, only if the server says it needs a session, run the
  // handshake once and retry.
  private async initialize(): Promise<void> {
    const msg = await this.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'kewy-ads', version: '0.1.0' },
    });
    if (msg?.error) {
      throw new Error(`Pipeboard MCP initialize failed: ${msg.error.code} ${msg.error.message}`);
    }
    // Best-effort "initialized" notification (no id, no result expected).
    try {
      await fetch(this.url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
    } catch { /* non-fatal */ }
  }

  private needsInit(err: any): boolean {
    const s = `${err?.code ?? ''} ${err?.message ?? ''}`.toLowerCase();
    return s.includes('session') || s.includes('initiali');
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<any> {
    let msg = await this.rpc('tools/call', { name, arguments: args });
    if (msg?.error && this.needsInit(msg.error)) {
      await this.initialize();
      msg = await this.rpc('tools/call', { name, arguments: args });
    }
    if (msg?.error) {
      throw new Error(`Pipeboard MCP ${name} failed: ${msg.error.code} ${msg.error.message}`);
    }
    const result = msg?.result;
    if (result?.isError) {
      const text = result?.content?.find((c: any) => c?.type === 'text')?.text;
      throw new Error(`Pipeboard tool ${name} returned an error: ${text ?? 'unknown'}`);
    }
    // Pipeboard nests the payload as an ESCAPED JSON STRING, sometimes under a
    // `result` key ({ result: "<json>" }). Unwrap+parse iteratively until we
    // reach the plain object the mappers expect — bounded so a genuinely stringy
    // payload can never loop forever.
    //
    // The parsed accounts payload also carries `summary` and `connections[]`
    // (connection_id, facebook_user_name). Not mapped now, but connections[] is
    // where per-connection identity lives — relevant later for Model A
    // per-tenant connections.
    const textBlock = result?.content?.find((c: any) => c?.type === 'text')?.text;
    let payload: any = result?.structuredContent ?? textBlock ?? result;
    for (let depth = 0; depth < 5; depth++) {
      if (typeof payload === 'string') {
        try {
          payload = JSON.parse(payload);
        } catch {
          throw new Error(`Pipeboard ${name}: unparseable string payload: ${payload.slice(0, 200)}`);
        }
        continue;
      }
      if (payload && typeof payload === 'object' && typeof payload.result === 'string') {
        payload = payload.result;   // descend into the { result: "<json>" } wrapper
        continue;
      }
      break;
    }
    return payload;
  }

  // Pipeboard payloads vary between {data:[…]}, {accounts:[…]} and bare arrays.
  private list(raw: any, ...keys: string[]): any[] {
    if (Array.isArray(raw)) return raw;
    for (const k of keys) if (Array.isArray(raw?.[k])) return raw[k];
    return [];
  }

  // ── Passthrough + discovery (Model A+) ──────────────────────────────────
  // callRaw reuses the SAME callTool path as the mapped reads, so it inherits the
  // initialize handshake, SSE parsing, string-payload unwrap, and — crucially —
  // the AdsProviderHttpError typing that lets the agent layer own retries. It does
  // NOT bypass the port to talk HTTP directly; "call an arbitrary tool by name" is
  // a legitimate port operation, just with a dynamic name instead of a hardcoded
  // one. The gate ABOVE this decides whether `toolName` is allowed here at all.
  async callRaw(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    return this.callTool(toolName, args ?? {});
  }

  // tools/list with annotations. Init-handshake retry mirrors callTool. Returns the
  // slim descriptor the gate cross-check + discovery need (name/description/schema/
  // annotations) — never the raw wire object.
  async listRawTools(): Promise<RawToolDescriptor[]> {
    let msg = await this.rpc('tools/list', {});
    if (msg?.error && this.needsInit(msg.error)) {
      await this.initialize();
      msg = await this.rpc('tools/list', {});
    }
    if (msg?.error) {
      throw new Error(`Pipeboard tools/list failed: ${msg.error.code} ${msg.error.message}`);
    }
    const tools = Array.isArray(msg?.result?.tools) ? msg.result.tools : [];
    return tools.map((t: any) => ({
      name: String(t?.name ?? ''),
      description: t?.description != null ? String(t.description) : undefined,
      inputSchema: t?.inputSchema,
      annotations: t?.annotations,
    }));
  }

  async getAdAccounts(): Promise<AdAccount[]> {
    const raw = await this.callTool('get_ad_accounts', { limit: 200 });
    return this.list(raw, 'data', 'accounts').map((a: any) =>
      adAccountSchema.parse({
        id: String(a?.id ?? a?.account_id ?? ''),
        name: String(a?.name ?? ''),
        currency: String(a?.currency ?? ''),
        status: ACCOUNT_STATUS[num(a?.account_status, -1)] ?? String(a?.account_status ?? 'UNKNOWN'),
      }),
    );
  }

  async getCampaigns(accountId: string, opts?: ListCampaignsOptions): Promise<AdsCampaign[]> {
    // Omit optional args entirely when unset — never send empty strings.
    const args: Record<string, unknown> = {
      account_id: accountId,
      limit: opts?.limit ?? CAMPAIGNS_FETCH_LIMIT, // was 50 → silently dropped 57 of 107 campaigns
    };
    if (opts?.status) args.status_filter = opts.status;

    const raw = await this.callTool('get_campaigns', args);
    const campaigns = this.list(raw, 'data', 'campaigns').map((c: any) =>
      adsCampaignSchema.parse({
        id: String(c?.id ?? ''),
        name: String(c?.name ?? ''),
        status: campaignStatus(c),
        objective: c?.objective != null ? String(c.objective) : null,
        dailyBudgetMinor: c?.daily_budget != null ? num(c.daily_budget) : null,
        effectiveStatus: c?.effective_status != null ? String(c.effective_status) : null,
      }),
    );
    return withHasMore(campaigns, raw);
  }

  async getInsights(accountId: string, params: AdsInsightsParams): Promise<AdsInsights[]> {
    const time_range =
      params.since && params.until
        ? { since: params.since, until: params.until }
        : params.datePreset ?? 'last_30d';
    const args: Record<string, unknown> = {
      object_id: accountId,
      level: params.level ?? 'account',
      time_range,
      limit: INSIGHTS_FETCH_LIMIT, // was omitted → Meta default 25 → silent page-1 truncation
    };
    // Omit breakdown keys entirely when unset — never send empties (our rule).
    if (params.breakdown) args.breakdown = params.breakdown;
    if (params.timeBreakdown) args.time_breakdown = params.timeBreakdown;

    const raw = await this.callTool('get_insights', args);

    const dim = params.breakdown;
    const hasTime = !!params.timeBreakdown;
    // time_breakdown returns a DIFFERENT shape: segmented_metrics[] (+ aggregates,
    // which we drop — callers wanting the total omit time_breakdown). Its rows
    // NEST metrics under `metrics` and use period_start/period_end. Plain and
    // demographic rows are FLAT with date_start/date_stop. The mapper reads BOTH
    // so a segmented row can never silently map to zeros. (Live shape unverified
    // from here — the timeBreakdown smoke confirms it.)
    let rows = hasTime ? this.list(raw, 'segmented_metrics') : this.list(raw, 'data', 'insights');
    if (rows.length === 0 && !dim && !hasTime) rows = [raw ?? {}]; // aggregate fallback

    // Surface the entity identity Meta already returns (campaign_id/name at
    // campaign+adset+ad level, adset_id/name at adset+ad level, ad_id/name at ad
    // level). Empty/absent → undefined so the optional schema fields are simply
    // omitted (never emitted as '').
    const idOf = (v: unknown) => (v == null || v === '' ? undefined : String(v));
    return withHasMore(rows.map((row: any) => {
      const m = hasTime ? (row?.metrics ?? row) : row; // segmented rows nest metrics
      const spend = num(m?.spend);
      const chatsStarted = firstPresent(m?.actions, MESSAGING_ORDER);
      const leads = firstPresent(m?.actions, LEAD_ORDER);
      const purchases = firstPresent(m?.actions, PURCHASE_ORDER);
      // Normalize Meta's dimension-specific field into a stable descriptor.
      const breakdown = dim ? { dimension: dim, value: String(row?.[dim] ?? m?.[dim] ?? '') } : null;
      return adsInsightsSchema.parse({
        breakdown,
        campaignId: idOf(row?.campaign_id ?? m?.campaign_id),
        campaignName: idOf(row?.campaign_name ?? m?.campaign_name),
        adsetId: idOf(row?.adset_id ?? m?.adset_id),
        adsetName: idOf(row?.adset_name ?? m?.adset_name),
        adId: idOf(row?.ad_id ?? m?.ad_id),
        adName: idOf(row?.ad_name ?? m?.ad_name),
        spend,
        impressions: num(m?.impressions),
        clicks: num(m?.clicks),
        ctr: num(m?.ctr),
        cpc: num(m?.cpc),
        chatsStarted,
        leads,
        purchases,
        costPerChat: costPer(spend, chatsStarted),
        costPerLead: costPer(spend, leads),
        costPerPurchase: costPer(spend, purchases),
        reach: m?.reach != null ? num(m.reach) : null,
        frequency: m?.frequency != null ? num(m.frequency) : null,
        // Segmented rows carry period_start/period_end; flat rows date_start/date_stop.
        dateStart: String(row?.period_start ?? row?.date_start ?? ''),
        dateStop: String(row?.period_end ?? row?.date_stop ?? ''),
      });
    }), raw);
  }
}
