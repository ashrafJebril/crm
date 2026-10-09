import type {
  AdAccount,
  AdsCampaign,
  AdsInsights,
  AdsInsightsParams,
  ListCampaignsOptions,
} from './ads.types';

/**
 * Platform-agnostic port for the Ads Assistant. PipeboardProvider is the
 * prototype (Meta via Pipeboard MCP); MetaOfficialProvider / Google / TikTok
 * land later behind the SAME interface. The agent layer and UI depend only on
 * this port, never on a concrete provider.
 *
 * The three MAPPED read methods stay — they are the hot path (pruned, Zod-shaped,
 * persona-rule-bound). Alongside them, callRaw() is the PASSTHROUGH: it invokes any
 * Pipeboard tool by name and returns the payload UNMAPPED. The port only executes;
 * WHETHER a given tool_name is allowed to reach callRaw is decided ABOVE it, by the
 * fail-closed gate in AdsChatService (see pipeboard-allowlist). In the tool loop only
 * allowlisted READS reach callRaw; a write reaches it solely via the owner-approved
 * execute path (later step). listRawTools() feeds discovery + the boot cross-check.
 */
export interface AdsProviderPort {
  getAdAccounts(): Promise<AdAccount[]>;
  getCampaigns(accountId: string, opts?: ListCampaignsOptions): Promise<AdsCampaign[]>;
  // Returns ONE row per breakdown bucket (single-row array when no breakdown).
  getInsights(accountId: string, params: AdsInsightsParams): Promise<AdsInsights[]>;
  // Raw passthrough — parsed payload, no Zod, no pruning. Byte ceiling + PII
  // redaction are applied by the CALLER (gate), not here (later step).
  callRaw(toolName: string, args: Record<string, unknown>): Promise<unknown>;
  // tools/list with MCP annotations, for discovery + crossCheckAllowlist().
  listRawTools(): Promise<RawToolDescriptor[]>;
}

/** One entry from tools/list — the fields the gate + discovery actually read. */
export interface RawToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

/** Nest DI token — bound to PipeboardProvider now, swapped later. */
export const ADS_PROVIDER = Symbol('ADS_PROVIDER');

/**
 * Transient upstream HTTP failure (e.g. Meta via Pipeboard): a 429 or 5xx that
 * MAY succeed on retry. Providers throw THIS (instead of a plain Error) for
 * retryable HTTP statuses so the agent layer can classify + retry WITHOUT
 * importing a concrete provider — the retryable policy and the per-request
 * tool-retry budget both live in AdsChatService, not in any provider.
 * `retryAfter` is the raw Retry-After header (delta-seconds or HTTP-date),
 * passed through untouched for the backoff to honor. Everything else — 4xx,
 * JSON-RPC 200-errors, tool isError, parse failures — stays a plain Error and
 * is terminal (never retried).
 */
export class AdsProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfter: string | null = null,
  ) {
    super(message);
    this.name = 'AdsProviderHttpError';
  }
}
