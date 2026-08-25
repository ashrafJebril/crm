import { z } from 'zod';

/**
 * Kewy Marketing Ads Assistant — read-only contracts (hjz-ads Phase 1).
 *
 * Platform-agnostic shapes the AdsProviderPort returns. The prototype provider
 * (Pipeboard → Meta) maps raw Meta Graph fields into these; a future
 * MetaOfficialProvider / Google / TikTok provider maps into the SAME shapes,
 * so the chat/agent layer and UI never change when the provider swaps.
 *
 * READ-ONLY phase: no create/update/proposal schemas here.
 */

// ── Ad account ────────────────────────────────────────────────────────────
export const adAccountSchema = z.object({
  id: z.string(),        // Meta: "act_1234567890"
  name: z.string(),
  currency: z.string(),  // ISO 4217, e.g. "USD" / "JOD"
  status: z.string(),    // normalized label, e.g. "ACTIVE" (see account_status map)
});
export type AdAccount = z.infer<typeof adAccountSchema>;

// ── Campaign ──────────────────────────────────────────────────────────────
export const adsCampaignStatusEnum = z.enum([
  'ACTIVE', 'PAUSED', 'DELETED', 'ARCHIVED', 'UNKNOWN',
]);
export type AdsCampaignStatus = z.infer<typeof adsCampaignStatusEnum>;

export const adsCampaignSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: adsCampaignStatusEnum,
  objective: z.string().nullable(),      // e.g. "OUTCOME_LEADS"
  // Meta returns daily_budget as a STRING in the account's MINOR currency unit
  // (e.g. "5000" = 50.00). Kept as minor-unit number; the UI divides by the
  // currency exponent when rendering. Null when the budget is set at ad-set level.
  dailyBudgetMinor: z.number().nullable(),
  effectiveStatus: z.string().nullable(),
});
export type AdsCampaign = z.infer<typeof adsCampaignSchema>;

// ── Insights ──────────────────────────────────────────────────────────────
// Breakdown dimensions — EXACTLY Pipeboard's supported values (do not invent).
// Creative-asset dimensions exist too but aren't named in our tool spec, so
// they're intentionally omitted until we have their exact keys.
export const adsInsightsBreakdownEnum = z.enum([
  'age', 'gender', 'country', 'region', 'dma',
  'device_platform', 'platform_position', 'publisher_platform', 'impression_device',
  'hourly_stats_aggregated_by_advertiser_time_zone',
]);
export type AdsInsightsBreakdown = z.infer<typeof adsInsightsBreakdownEnum>;

export const adsTimeBreakdownEnum = z.enum(['day', 'week', 'month']);
export type AdsTimeBreakdown = z.infer<typeof adsTimeBreakdownEnum>;

export const adsInsightsSchema = z.object({
  // Which segment this row is, when a breakdown was requested; null for the
  // aggregate / no-breakdown row. `dimension` names the breakdown; `value` is
  // Meta's raw bucket label (e.g. '25-34', 'Amman', '14:00:00 - 14:59:59').
  breakdown: z.object({
    dimension: adsInsightsBreakdownEnum,
    value: z.string(),
  }).nullable().default(null),
  // Entity identity for this row — populated by the provider from fields Meta
  // ALREADY returns (campaign_id/name at campaign+adset+ad level; adset_id/name
  // at adset+ad level; ad_id/name at ad level). Optional because they're absent
  // at higher aggregation: an account-level row has none, a campaign-level row
  // has campaign* only, an adset-level row has campaign*+adset*. Without these,
  // non-account rows are anonymous and the assistant cannot say WHICH
  // campaign/ad set/ad a metric belongs to.
  campaignId: z.string().optional(),
  campaignName: z.string().optional(),
  adsetId: z.string().optional(),
  adsetName: z.string().optional(),
  adId: z.string().optional(),
  adName: z.string().optional(),
  spend: z.number(),
  impressions: z.number(),
  clicks: z.number(),
  ctr: z.number(),                       // percentage
  cpc: z.number(),                       // cost per click, account currency
  // Three INDEPENDENT per-family result counts (see firstPresent in the
  // provider). Each = the first-present alias in its approved priority order —
  // deduped WITHIN a family; NEVER summed within or across families, because a
  // `lead` may already be inside a messaging conversation (chatsStarted). null =
  // the family did not fire on this row (NOT zero).
  chatsStarted: z.number().nullable(),   // messaging_conversation_started_7d
  leads: z.number().nullable(),          // lead family, first-present of the priority order
  purchases: z.number().nullable(),      // purchase family, first-present of the priority order
  // Cost per result, paired 1:1 with each count above: spend / count, born
  // ROUNDED to 4 decimals; null whenever its count is null (or ≤ 0). NOT
  // comparable to one another — never sum or average across the three.
  costPerChat: z.number().nullable(),
  costPerLead: z.number().nullable(),
  costPerPurchase: z.number().nullable(),
  // Reach = unique people; frequency = avg impressions per person. Meta returns
  // both at account/campaign/adset/ad level (and per breakdown/segment bucket).
  // Nullable — not num()→0 — so a bucket that omits them is never read as "0
  // reach / no fatigue" (same nullable-metric pattern as the cost fields above).
  reach: z.number().nullable(),
  frequency: z.number().nullable(),
  dateStart: z.string(),                 // YYYY-MM-DD
  dateStop: z.string(),
});
export type AdsInsights = z.infer<typeof adsInsightsSchema>;

// ── Port params ───────────────────────────────────────────────────────────
export const insightsLevelEnum = z.enum(['account', 'campaign', 'adset', 'ad']);
export type InsightsLevel = z.infer<typeof insightsLevelEnum>;

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

// Shared predicate: a since/until window must be given as a pair, never one side.
const sinceUntilPaired = (v: { since?: string; until?: string }) =>
  (v.since ? !!v.until : true) && (v.until ? !!v.since : true);
const sinceUntilPairedMsg = { message: 'since and until must be provided together' };

/** Plain object base — no refinement, so it can be extended/merged cleanly. */
const adsInsightsParamsBase = z.object({
  level: insightsLevelEnum.default('account'),
  datePreset: z.string().optional(), // e.g. "last_30d", "this_month"
  since: dateStr.optional(),
  until: dateStr.optional(),
  // Segment by ONE demographic/placement dimension → one row per bucket.
  breakdown: adsInsightsBreakdownEnum.optional(),
  // Segment over time → segmented_metrics rows. Combinable with breakdown.
  timeBreakdown: adsTimeBreakdownEnum.optional(),
});

/** Params for getInsights(accountId, params). Either a Meta preset OR since+until. */
export const adsInsightsParamsSchema = adsInsightsParamsBase.refine(
  sinceUntilPaired,
  sinceUntilPairedMsg,
);
export type AdsInsightsParams = z.infer<typeof adsInsightsParamsSchema>;

/** Options for getCampaigns(accountId, opts?). */
export const listCampaignsOptionsSchema = z.object({
  status: adsCampaignStatusEnum.optional(),
  limit: z.number().int().positive().max(200).optional(),
});
export type ListCampaignsOptions = z.infer<typeof listCampaignsOptionsSchema>;

// ── HTTP request/response wrappers (for the read endpoints in a later phase) ─
export const listAdAccountsResponseSchema = z.object({ accounts: z.array(adAccountSchema) });
export type ListAdAccountsResponse = z.infer<typeof listAdAccountsResponseSchema>;

export const listCampaignsRequestSchema = z
  .object({ accountId: z.string() })
  .merge(listCampaignsOptionsSchema);
export type ListCampaignsRequest = z.infer<typeof listCampaignsRequestSchema>;

export const listCampaignsResponseSchema = z.object({ campaigns: z.array(adsCampaignSchema) });
export type ListCampaignsResponse = z.infer<typeof listCampaignsResponseSchema>;

// Extend the plain BASE object (a ZodObject, not a ZodEffects), then apply the
// SAME refine to the merged schema — no ZodEffects merging.
export const getInsightsRequestSchema = adsInsightsParamsBase
  .extend({ accountId: z.string() })
  .refine(sinceUntilPaired, sinceUntilPairedMsg);
export type GetInsightsRequest = z.infer<typeof getInsightsRequestSchema>;

// ── Prompt catalog (hjz-ads — server-side starter prompts + lifecycle) ──────
export const adsPromptCategoryEnum = z.enum([
  'analysis', 'optimization', 'audience', 'creative', 'trends', 'create', 'bulk_ops',
]);
export type AdsPromptCategory = z.infer<typeof adsPromptCategoryEnum>;

export const adsPromptStatusEnum = z.enum(['active', 'coming_soon']);
export type AdsPromptStatus = z.infer<typeof adsPromptStatusEnum>;

// What a coming_soon entry waits on. ARRAY on the entry — a prompt may need more
// than one capability (bulk_creative_swap / create_retargeting = write_path +
// creative_tools). Empty for active entries. REQUIRED (no default): every entry
// declares it explicitly, so a missing declaration is a compile error, not a
// silent [].
export const adsPromptBlockedByEnum = z.enum([
  'write_path',      // two-gate create/update path
  'creative_tools',  // get_ad_creatives / get_ad_video / get_custom_audiences
  'entity_tools',    // adset fields insights don't expose (e.g. learning_stage_info)
]);
export type AdsPromptBlockedBy = z.infer<typeof adsPromptBlockedByEnum>;

export const adsLocaleEnum = z.enum(['ar', 'en']);
export type AdsLocale = z.infer<typeof adsLocaleEnum>;

// One catalog entry as exposed by GET /ads/prompts (both languages; the web
// picks per i18n.language). promptAr/promptEn are written natively, not translated.
export const adsPromptSchema = z.object({
  id: z.string(),
  category: adsPromptCategoryEnum,
  status: adsPromptStatusEnum,
  blockedBy: z.array(adsPromptBlockedByEnum),
  titleAr: z.string(),
  titleEn: z.string(),
  descAr: z.string(),
  descEn: z.string(),
  promptAr: z.string(),
  promptEn: z.string(),
});
export type AdsPromptEntry = z.infer<typeof adsPromptSchema>;

export const adsTipSchema = z.object({
  id: z.string(),
  titleAr: z.string(), titleEn: z.string(),
  bodyAr: z.string(),  bodyEn: z.string(),
});
export type AdsTip = z.infer<typeof adsTipSchema>;

export const getAdsPromptsResponseSchema = z.object({
  prompts: z.array(adsPromptSchema),
  tips: z.array(adsTipSchema),
});
export type GetAdsPromptsResponse = z.infer<typeof getAdsPromptsResponseSchema>;

// ── Chat persistence (hjz-ads — per-tenant history + audit) ─────────────────
// Role values are lowercase to mirror the Anthropic wire + the API surface. No
// `AdsChatRole` type is exported here on purpose: the Prisma client generates a
// type of that name (UPPERCASE), and the service maps at the persistence
// boundary — keeping the names from colliding across this file + Prisma.
export const adsChatRoleEnum = z.enum(['user', 'assistant']);

export const adsChatMessageSchema = z.object({
  id: z.string(),
  role: adsChatRoleEnum,
  content: z.string(),
  createdAt: z.string(), // ISO; serialized
});
export type AdsChatMessageDto = z.infer<typeof adsChatMessageSchema>;

export const adsChatSessionSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AdsChatSessionDto = z.infer<typeof adsChatSessionSchema>;

// POST body: omit sessionId to start a new session; otherwise append to it.
// Provide EXACTLY ONE of `message` (free text) or `promptId` (resolved
// server-side in `locale`). Exactly-one — not at-least-one — so sending both can
// never silently drop the typed message. A coming_soon/unknown promptId is
// rejected 400 server-side; the UI lock is cosmetic.
export const postAdsChatRequestSchema = z
  .object({
    sessionId: z.string().optional(),
    message: z.string().min(1).max(2000).optional(),
    promptId: z.string().optional(),
    locale: adsLocaleEnum.default('ar'),
  })
  .refine((v) => (v.message?.trim() ? 1 : 0) + (v.promptId ? 1 : 0) === 1, {
    message: 'provide exactly one of message or promptId',
  });
export type PostAdsChatRequest = z.infer<typeof postAdsChatRequestSchema>;

// ── Gated write proposal (hjz-ads — the two-gate confirm/approve path) ──────
// Salma PROPOSES a write via pipeboard_call; the gate refuses to execute and mints
// an AdsPendingAction. This DTO carries it to the web so the UI can render an
// approval CARD (summary + spend + موافق/رفض) — the ONLY way an action reaches the
// authenticated POST /ads/actions/:id/approve. summaryIsPlaceholder=true → the
// summary isn't machine-rendered yet (STEP-5 renderers) and approve is refused
// server-side, so the card disables موافق. currency is null until the renderers
// fetch the REAL account currency (never guessed).
export const adsPendingActionStatusEnum = z.enum([
  'PENDING', 'EXECUTING', 'EXECUTED', 'FAILED', 'REJECTED', 'EXPIRED',
]);
export type AdsPendingActionStatus = z.infer<typeof adsPendingActionStatusEnum>;

export const adsPendingActionSpendSchema = z.object({
  field: z.string(),          // e.g. "daily_budget"
  minorValue: z.number(),     // raw value as Meta receives it (account minor unit)
  majorEstimate: z.number(),  // conservative minorValue/100 until the currency is known
});

export const adsPendingActionSchema = z.object({
  actionId: z.string(),
  tool: z.string(),
  summary: z.string(),
  summaryIsPlaceholder: z.boolean(),
  status: adsPendingActionStatusEnum,
  currency: z.string().nullable(),        // ISO 4217; null until STEP-5 renderers fetch it
  spend: z.array(adsPendingActionSpendSchema),
  spendWarn: z.boolean(),
  spendWarnThresholdJod: z.number(),      // ADS_APPROVAL_AMOUNT_WARN (default 50)
  createdAt: z.string(),                  // ISO; serialized
  expiresAt: z.string(),                  // ISO; serialized
});
export type AdsPendingActionDto = z.infer<typeof adsPendingActionSchema>;

export const postAdsChatResponseSchema = z.object({
  sessionId: z.string(),
  reply: z.string(),
  messages: z.array(adsChatMessageSchema),
  // Wallet balance AFTER this reply's debit (Decimal(12,4) serialized) — lets
  // the UI update its counter without a second GET /ads/wallet.
  balanceAfterJod: z.string(),
  // Gated write proposals still awaiting approval in this session (PENDING + not
  // expired). Present on every response; [] when the turn proposed nothing. Same
  // shape + source as getSession.pendingActions, so a live card == a reloaded card.
  proposals: z.array(adsPendingActionSchema).default([]),
});
export type PostAdsChatResponse = z.infer<typeof postAdsChatResponseSchema>;

export const listAdsChatSessionsResponseSchema = z.object({
  sessions: z.array(adsChatSessionSchema),
});
export type ListAdsChatSessionsResponse = z.infer<typeof listAdsChatSessionsResponseSchema>;

export const getAdsChatSessionResponseSchema = z.object({
  session: adsChatSessionSchema,
  messages: z.array(adsChatMessageSchema),
  // Open proposals for this session, so a reload re-hydrates approval cards — a
  // waiting card the user can't find after refresh is the same as no card.
  pendingActions: z.array(adsPendingActionSchema).default([]),
});
export type GetAdsChatSessionResponse = z.infer<typeof getAdsChatSessionResponseSchema>;

// ── Wallet (hjz-ads — pre-funded JOD balance + metered debits) ──────────────
// One wallet per tenant; the monthly subscription grant and top-ups land in
// the SAME balance. Every Claude reply debits it by real token usage. Prices,
// margin and FX are backend config — the tenant only ever sees JOD.
//
// Decimal money fields are serialized as STRINGS (Prisma Decimal → string) to
// preserve the (12,4) precision that micro-billing needs — a float would drift.
// Mirrors this file's `createdAt: z.string() // serialized` precedent.
//
// These accounting types stay UPPERCASE on the wire: they're internal ledger
// categories, not a tenant/model-facing enum. No `AdsWalletTxType` TS type is
// exported — Prisma generates one under that name; the service maps at the
// persistence boundary (same reasoning as `adsChatRoleEnum` above).
export const adsWalletTxTypeEnum = z.enum([
  'MONTHLY_GRANT', 'TOPUP', 'DEBIT', 'REFUND', 'ADJUST',
]);

export const adsWalletSchema = z.object({
  balanceJod: z.string(), // Decimal(12,4) serialized
  updatedAt: z.string(),  // ISO; serialized
});
export type AdsWalletDto = z.infer<typeof adsWalletSchema>;

export const adsWalletTransactionSchema = z.object({
  id: z.string(),
  type: adsWalletTxTypeEnum,
  amountJod: z.string(),       // Decimal(12,4) serialized; signed per type
  balanceAfterJod: z.string(), // Decimal(12,4) serialized; snapshot at write-time
  description: z.string().nullable(),
  createdAt: z.string(),       // ISO; serialized
});
export type AdsWalletTransactionDto = z.infer<typeof adsWalletTransactionSchema>;

export const getAdsWalletResponseSchema = z.object({
  wallet: adsWalletSchema,
  recentTransactions: z.array(adsWalletTransactionSchema),
});
export type GetAdsWalletResponse = z.infer<typeof getAdsWalletResponseSchema>;

export const listAdsWalletTransactionsResponseSchema = z.object({
  transactions: z.array(adsWalletTransactionSchema),
});
export type ListAdsWalletTransactionsResponse = z.infer<
  typeof listAdsWalletTransactionsResponseSchema
>;

// ── Wallet top-up (hjz-ads — Stripe Checkout) ───────────────────────────────
// STRUCTURAL / protocol validation ONLY — NO business floor here:
//  - ≤2 decimals: JOD is a THREE-decimal Stripe currency and Stripe requires the
//    minor-unit amount to be a multiple of 10 (thousandths digit 0); ≤2 decimals
//    guarantees it (× 1000 = cents × 10).
//  - a sane absolute max: a runaway-value guard, not policy.
// The BUSINESS floor is env-configurable and lives in ONE place: the controller
// (ADS_MIN_TOPUP_JOD, default 5). It is deliberately NOT duplicated here — a
// floor in this isomorphic package can't read env, and would silently CAP the
// operator's setting (env could then only raise, never lower). One rule, one
// source of truth.
// Exported so the controller (which enforces the top-up rules for the
// class-validator DTO — see ads.dto.ts) uses the SAME cap as this schema
// instead of a second copy of the number.
export const ADS_TOPUP_MAX_JOD = 10000;

export const postAdsTopupRequestSchema = z.object({
  amountJod: z
    .string()
    .regex(/^\d+(\.\d{1,2})?$/, 'amountJod must be a decimal string with at most 2 places')
    .refine((v) => Number(v) <= ADS_TOPUP_MAX_JOD, `amountJod must not exceed ${ADS_TOPUP_MAX_JOD} JOD`),
});
export type PostAdsTopupRequest = z.infer<typeof postAdsTopupRequestSchema>;

export const postAdsTopupResponseSchema = z.object({ checkoutUrl: z.string().url() });
export type PostAdsTopupResponse = z.infer<typeof postAdsTopupResponseSchema>;
