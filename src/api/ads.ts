// Ads Assistant (Salma) — API types + hooks.
// Mirrors backend/src/ads/ads.controller.ts + ads.types.ts (hand-written, no
// zod import — the backend module owns the zod schemas; this file just types
// the wire shapes the CRM frontend actually receives/sends).
//
// Prisma Decimal fields (balanceJod, amountJod, balanceAfterJod, costBasis*)
// serialize as STRINGS over the wire (see ads-wallet.service.ts's `decStr`) —
// typed `string` here, never `number`.
import { api } from "./client";
import { useFetch } from "./useFetch";

// ── Prompt catalog (GET /ads/prompts) ───────────────────────────────────────
export type AdsPromptCategory =
  | "analysis"
  | "optimization"
  | "audience"
  | "creative"
  | "trends"
  | "create"
  | "bulk_ops";

export type AdsPromptStatus = "active" | "coming_soon";

// What a coming_soon prompt is waiting on. Array — a prompt may need more than
// one capability. Empty for active entries.
export type AdsPromptBlockedBy = "write_path" | "creative_tools" | "entity_tools";

export type AdsLocale = "ar" | "en";

export interface AdsPromptEntry {
  id: string;
  category: AdsPromptCategory;
  status: AdsPromptStatus;
  blockedBy: AdsPromptBlockedBy[];
  titleAr: string;
  titleEn: string;
  descAr: string;
  descEn: string;
  promptAr: string;
  promptEn: string;
}

export interface AdsTip {
  id: string;
  titleAr: string;
  titleEn: string;
  bodyAr: string;
  bodyEn: string;
}

export interface GetAdsPromptsResponse {
  prompts: AdsPromptEntry[];
  tips: AdsTip[];
}

// ── Chat persistence ─────────────────────────────────────────────────────────
// Wire role is lowercase — the service maps the Prisma-uppercase DB role
// (USER/ASSISTANT) down to this at the persistence boundary (toWireRole in
// ads-chat-session.service.ts), so the HTTP response never carries uppercase.
export type AdsChatRole = "user" | "assistant";

export interface AdsChatMessageDto {
  id: string;
  role: AdsChatRole;
  content: string;
  createdAt: string; // ISO
}

export interface AdsChatSessionDto {
  id: string;
  title: string | null;
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

export interface ListAdsChatSessionsResponse {
  sessions: AdsChatSessionDto[];
}

// ── Gated write proposals (the two-gate confirm/approve path) ──────────────
export type AdsPendingActionStatus =
  | "PENDING"
  | "EXECUTING"
  | "EXECUTED"
  | "FAILED"
  | "REJECTED"
  | "EXPIRED";

export interface AdsPendingActionSpend {
  field: string; // e.g. "daily_budget"
  minorValue: number; // raw value as Meta receives it (account minor unit)
  majorEstimate: number; // conservative minorValue/100 until the currency is known
}

export interface AdsPendingActionDto {
  actionId: string;
  tool: string;
  summary: string;
  // true → the summary isn't machine-rendered yet; approve is refused
  // server-side, so the card should disable its approve button.
  summaryIsPlaceholder: boolean;
  status: AdsPendingActionStatus;
  currency: string | null; // ISO 4217; null until the real account currency is fetched
  spend: AdsPendingActionSpend[];
  spendWarn: boolean;
  spendWarnThresholdJod: number;
  createdAt: string; // ISO
  expiresAt: string; // ISO
}

// POST body: omit sessionId to start a new session; otherwise append to it.
// Provide exactly one of `message` or `promptId` — enforced server-side (400).
// `locale` defaults to 'ar' server-side when omitted.
export interface PostAdsChatRequest {
  sessionId?: string;
  message?: string;
  promptId?: string;
  locale?: AdsLocale;
}

export interface PostAdsChatResponse {
  sessionId: string;
  reply: string;
  messages: AdsChatMessageDto[];
  // Decimal(12,4) serialized — wallet balance AFTER this reply's debit.
  balanceAfterJod: string;
  // Open (PENDING, not expired) write proposals from this turn. Always
  // present; [] when nothing was proposed.
  proposals: AdsPendingActionDto[];
}

export interface GetAdsChatSessionResponse {
  session: AdsChatSessionDto;
  messages: AdsChatMessageDto[];
  // Open proposals for this session, so a reload re-hydrates approval cards.
  pendingActions: AdsPendingActionDto[];
}

// ── Wallet (pre-funded JOD balance + metered debits) ────────────────────────
export type AdsWalletTxType = "MONTHLY_GRANT" | "TOPUP" | "DEBIT" | "REFUND" | "ADJUST";

export interface AdsWalletDto {
  balanceJod: string; // Decimal(12,4) serialized
  updatedAt: string; // ISO
}

export interface AdsWalletTransactionDto {
  id: string;
  type: AdsWalletTxType;
  amountJod: string; // Decimal(12,4) serialized; signed per type
  balanceAfterJod: string; // Decimal(12,4) serialized; snapshot at write-time
  description: string | null;
  createdAt: string; // ISO
}

export interface GetAdsWalletResponse {
  wallet: AdsWalletDto;
  recentTransactions: AdsWalletTransactionDto[];
}

export interface PostAdsTopupResponse {
  checkoutUrl: string;
}

// ── Approve / reject a pending action ───────────────────────────────────────
export interface ApproveAdsActionResponse {
  status: "executed" | "already_executed";
  actionId: string;
  tool: string;
  summary: string;
  sessionId: string | null;
  // The provider's raw call result (e.g. { id: "<new entity id>" } for a
  // create_* tool). Shape varies per tool — the caller reads fields it knows.
  result: unknown;
}

export interface RejectAdsActionResponse {
  status: "rejected" | "already_rejected";
  actionId: string;
  tool: string;
  sessionId: string | null;
}

// ── Hooks (house useFetch wrapper — see src/api/useFetch.ts) ────────────────
export function useAdsPrompts() {
  return useFetch<GetAdsPromptsResponse>("/ads/prompts", { key: "ads-prompts" });
}

export function useAdsWallet() {
  return useFetch<GetAdsWalletResponse>("/ads/wallet", { key: "ads-wallet" });
}

export function useAdsChatSession(id: string | null) {
  return useFetch<GetAdsChatSessionResponse>(
    id ? `/ads/chat/sessions/${id}` : null,
    { enabled: !!id },
  );
}

// ── Plain async calls (mutation state managed by the caller, as hjz did) ───

// Streams over SSE (see api.postStream) — resolves with the byte-identical
// PostAdsChatResponse the buffered endpoint would have returned, or throws an
// ApiError carrying { code, message } from either a pre-flush HTTP error
// (400/402) or a post-flush `event: error` frame.
export function postAdsChat(body: PostAdsChatRequest): Promise<PostAdsChatResponse> {
  return api.postStream<PostAdsChatResponse>("/ads/chat", body);
}

// Body-less by design: approval IS this authenticated POST.
export function approveAdsAction(id: string): Promise<ApproveAdsActionResponse> {
  return api.post<ApproveAdsActionResponse>(`/ads/actions/${id}/approve`);
}

export function rejectAdsAction(id: string): Promise<RejectAdsActionResponse> {
  return api.post<RejectAdsActionResponse>(`/ads/actions/${id}/reject`);
}

// amountJod crosses the wire as a JSON NUMBER (not a decimal string) — the
// backend's PostAdsTopupDto takes @IsNumber(), and the controller converts it
// to a 2-decimal string internally for the payment gateway.
export function createAdsTopup(amountJod: number): Promise<PostAdsTopupResponse> {
  return api.post<PostAdsTopupResponse>("/ads/wallet/topup", { amountJod });
}
