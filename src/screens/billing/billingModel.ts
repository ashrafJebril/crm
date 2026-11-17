/**
 * SP-28 billing, read-only over Kewy data (pure). Kewy/Joteck bills the
 * workspace: there is no checkout, invoice, payment method, top-up or trial
 * here. Prices, allowances and seats show only once the user has set them
 * (R3: null = hidden). Amounts are JOD with three decimals and Latin digits.
 */
import type { BillingBanner, BillingCatalogPlan, BillingMeter, BillingStatus, Lang } from "@/lib/types";

type Copy = [en: string, ar: string];
const pick = (c: Copy, lang: Lang) => c[lang === "ar" ? 1 : 0];

export const METERS: readonly BillingMeter[] = ["ai_reply", "campaign_message", "ads_ai"];

export const METER_COPY: Record<BillingMeter, Copy> = {
  ai_reply: ["AI replies", "ردود الذكاء الاصطناعي"],
  campaign_message: ["Campaign messages", "رسائل الحملات"],
  ads_ai: ["Ads assistant turns", "محادثات مساعد الإعلانات"],
};

/** Every plan feature the backend knows (pinned to backend/src/billing/plan-catalog.ts). */
export const FEATURE_COPY: Record<string, Copy> = {
  campaigns: ["Campaigns", "الحملات"],
  smart_audiences: ["Smart audiences", "الجماهير الذكية"],
  insights: ["Insights", "التحليلات"],
  api_access: ["API access", "الوصول عبر API"],
  webhooks: ["Webhooks", "الويب هوك"],
  ai_tools: ["AI tools", "أدوات الذكاء الاصطناعي"],
  bookings_catalog_import: ["Importing services and staff", "استيراد الخدمات والموظفين"],
  copilot: ["Copilot", "المساعد الذكي"],
};

export function featureLabel(feature: string, lang: Lang): string {
  const c = FEATURE_COPY[feature];
  return c ? pick(c, lang) : feature.replace(/_/g, " ");
}

export const PLAN_COPY: Record<string, Copy> = {
  free: ["Free", "المجانية"],
  starter: ["Starter", "المبتدئة"],
  growth: ["Growth", "النمو"],
  pro: ["Pro", "الاحترافية"],
};

/** A catalogue key in words; a Kewy package name as Kewy named it. */
export function planLabel(plan: { key: string | null; name: string } | string | null | undefined, lang: Lang): string {
  if (!plan) return pick(["No plan", "بدون باقة"], lang);
  const key = typeof plan === "string" ? plan.trim().toLowerCase() : plan.key;
  const name = typeof plan === "string" ? plan : plan.name;
  const c = key ? PLAN_COPY[key] : undefined;
  return c ? pick(c, lang) : name;
}

export const LEDGER_TYPE_COPY: Record<string, Copy> = {
  TOPUP: ["Top-up", "شحن رصيد"],
  MONTHLY_GRANT: ["Monthly credit", "رصيد شهري"],
  DEBIT: ["Usage", "استهلاك"],
  REFUND: ["Refund", "استرداد"],
  ADJUST: ["Adjustment", "تعديل"],
};

export function ledgerTypeLabel(type: string, lang: Lang): string {
  const c = LEDGER_TYPE_COPY[type];
  return c ? pick(c, lang) : type;
}

// ── money ────────────────────────────────────────────────────────────────

/** A JOD amount (`"12.3456"`): three decimals, Latin digits in Arabic too. */
export function formatJod(amount: string | number | null | undefined, lang: Lang): string {
  const n = typeof amount === "number" ? amount : Number(amount);
  const v = Number.isFinite(n) ? n : 0;
  return new Intl.NumberFormat(lang === "ar" ? "ar-JO-u-nu-latn" : "en-JO", {
    style: "currency",
    currency: "JOD",
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  }).format(v);
}

export const formatCount = (n: number) => new Intl.NumberFormat("en-US").format(n);

// ── banners ──────────────────────────────────────────────────────────────

export type BannerKind = "payment_due" | "wallet_low" | "wallet_empty";

export interface BannerView {
  kind: BannerKind;
  tone: "warn" | "bad";
  text: Copy;
  /** The payment-due countdown is the lock warning every member must see: never dismissible. */
  dismissible: boolean;
}

const HOUR_MS = 3_600_000;

/** "1 day 4 hours" / "3 hours" / "less than an hour" until the lock. */
export function countdownText(locksAt: string, now: Date): Copy {
  const ms = new Date(locksAt).getTime() - now.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return ["now", "الآن"];
  const hours = Math.floor(ms / HOUR_MS);
  if (hours < 1) return ["less than an hour", "أقل من ساعة"];
  const d = Math.floor(hours / 24);
  const h = hours % 24;
  const en = [d ? `${d} day${d === 1 ? "" : "s"}` : "", h ? `${h} hour${h === 1 ? "" : "s"}` : ""].filter(Boolean).join(" ");
  const ar = [d ? (d === 1 ? "يوم" : d === 2 ? "يومين" : `${d} أيام`) : "", h ? (h === 1 ? "ساعة" : h === 2 ? "ساعتين" : `${h} ساعات`) : ""]
    .filter(Boolean)
    .join(" و");
  return [en, ar];
}

export const BANNER_COPY = {
  payment_due: (left: Copy): Copy => [
    `A payment is due. The workspace locks in ${left[0]} unless it is paid in Kewy.`,
    `هناك دفعة مستحقة. ستُقفل مساحة العمل خلال ${left[1]} ما لم تُدفع عبر كيوي.`,
  ],
  wallet_low: [
    "Your wallet is running low. The ads assistant stops when it runs out.",
    "رصيد محفظتك منخفض. يتوقف مساعد الإعلانات عند نفاد الرصيد.",
  ] as Copy,
  wallet_empty: ["Your wallet is empty. The ads assistant is paused until it is topped up.", "محفظتك فارغة. مساعد الإعلانات متوقف حتى يُشحن الرصيد."] as Copy,
};

/**
 * The banners for a status (`GET /billing/status`): every member sees the
 * payment-due countdown; the wallet ones exist only in the billing.view
 * payload (the reduced one has no wallet and no `low_balance`).
 */
export function bannersFor(status: BillingStatus | null | undefined, now: Date): BannerView[] {
  if (!status) return [];
  const out: BannerView[] = [];
  const has = (b: BillingBanner) => status.banners.includes(b);
  if (has("grace") && status.payment.locksAt && !status.payment.locked) {
    out.push({ kind: "payment_due", tone: "bad", dismissible: false, text: BANNER_COPY.payment_due(countdownText(status.payment.locksAt, now)) });
  }
  if (has("low_balance") && status.wallet) {
    const empty = Number(status.wallet.balanceJod) <= 0;
    out.push({ kind: empty ? "wallet_empty" : "wallet_low", tone: "warn", dismissible: true, text: empty ? BANNER_COPY.wallet_empty : BANNER_COPY.wallet_low });
  }
  return out;
}

/** A local day (YYYY-MM-DD) in the workspace timezone. */
export function workspaceDay(at: Date, tz: string | null | undefined): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz || "Asia/Riyadh", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/** A dismissed wallet banner stays hidden for the rest of the workspace's local day (per kind). */
export const dismissKey = (kind: BannerKind, now: Date, tz: string | null | undefined) =>
  `billing.banner.${kind}.${workspaceDay(now, tz)}`;

// ── catalogue placeholders (R3) ──────────────────────────────────────────

export interface PlanCardView {
  key: string;
  /** Only when set. */
  monthlyJod: number | null;
  annualJod: number | null;
  allowances: { meter: BillingMeter; value: number }[];
  whatsappNumbers: number;
  seats: number | null;
}

/** A catalogue plan with every unset value dropped (null/absent = hidden). */
export function planCardView(p: BillingCatalogPlan): PlanCardView {
  const a = p.allowances ?? {};
  return {
    key: p.key,
    monthlyJod: p.priceJod?.monthly ?? null,
    annualJod: p.priceJod?.annual ?? null,
    allowances: METERS.filter((m) => typeof a[m] === "number").map((m) => ({ meter: m, value: a[m] as number })),
    whatsappNumbers: p.limits.whatsappNumbers,
    seats: typeof p.limits.seats === "number" ? p.limits.seats : null,
  };
}

/** "120 of 500" when an allowance is set, else just the count. */
export function usageText(used: number, allowance: number | null, lang: Lang): string {
  return allowance === null || allowance === undefined
    ? formatCount(used)
    : lang === "ar"
      ? `${formatCount(used)} من ${formatCount(allowance)}`
      : `${formatCount(used)} of ${formatCount(allowance)}`;
}

/** Daily series for the chart: every day of the range, zero-filled (YYYY-MM-DD keys). */
export function fillDays(days: { day: string; qty: number }[], fromDay: string, toDay: string): { day: string; qty: number }[] {
  const by = new Map(days.map((d) => [d.day, d.qty]));
  const out: { day: string; qty: number }[] = [];
  let t = Date.parse(`${fromDay}T00:00:00Z`);
  const end = Date.parse(`${toDay}T00:00:00Z`);
  for (let i = 0; Number.isFinite(t) && t <= end && i < 400; i++, t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    out.push({ day, qty: by.get(day) ?? 0 });
  }
  return out;
}
