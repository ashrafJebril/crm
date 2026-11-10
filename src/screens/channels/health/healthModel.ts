import type { Tx } from "@/lib/tx";
import type {
  ChannelDto,
  ChannelHealthPublic,
  HealthFieldName,
  HealthOverall,
  HealthSignal,
  HealthSignalError,
  HealthTemplatesSignal,
} from "@/lib/types";

/**
 * SP-14 number and template health: the pure view-model behind the Number
 * health page, the channel detail section, the template health sheet and the
 * sender chips. No React, so every label is unit-tested.
 *
 * The rule (R1, Global Constraints): "unknown" is a first-class value. It is
 * shown as a muted "Unknown" with the reason, never blank, never a dash and
 * never green. A previous value (`lastKnown`) is shown as previous, never as
 * the current value.
 */

export const UNKNOWN = "unknown";

export type Tone = "good" | "warn" | "bad" | "neutral";

/** What a displayed value is: a real provider value, or why it is unknown. */
export type ValueState = "real" | "not_checked" | Exclude<HealthSignalError, null>;

/** The order the detail grid and the overview use. */
export const FIELD_ORDER: readonly HealthFieldName[] = [
  "quality",
  "tier",
  "messaging",
  "nameStatus",
  "phoneStatus",
  "verified",
  "codeVerification",
  "accountReview",
];

export interface Copy {
  en: string;
  ar: string;
}

export const FIELD_LABEL: Record<HealthFieldName | "templates", Copy> = {
  quality: { en: "Quality rating", ar: "تقييم الجودة" },
  // R14: Meta sets the limit per business portfolio, shared by all its numbers.
  tier: { en: "Daily limit (shared by numbers in this business)", ar: "الحد اليومي (مشترك بين أرقام هذا النشاط)" },
  messaging: { en: "Messaging", ar: "المراسلة" },
  nameStatus: { en: "Display name", ar: "الاسم الظاهر" },
  phoneStatus: { en: "Phone status", ar: "حالة الرقم" },
  verified: { en: "Business verification", ar: "توثيق النشاط التجاري" },
  codeVerification: { en: "Number verification", ar: "التحقق من الرقم" },
  accountReview: { en: "Account review", ar: "مراجعة الحساب" },
  templates: { en: "Templates needing review", ar: "قوالب تحتاج إلى مراجعة" },
};

export const TIER_SHARED_NOTE: Copy = {
  en: "Meta sets this limit for the whole business. Every number in it shares the same daily limit.",
  ar: "تضع Meta هذا الحد للنشاط التجاري كاملًا، وتتشاركه كل أرقامه يوميًا.",
};

export const UNKNOWN_LABEL: Copy = { en: "Unknown", ar: "غير معروف" };

export const SOURCE_LABEL: Copy = {
  en: "Via Zernio (unverified field)",
  ar: "عبر Zernio (حقل غير موثّق)",
};

export const STATE_LABEL: Record<ValueState, Copy> = {
  real: { en: "Reported", ar: "مُبلَّغ عنه" },
  not_checked: { en: "Not checked yet", ar: "لم يُفحص بعد" },
  unsupported: { en: "Not reported by this provider", ar: "لا يوفّره هذا المزوّد" },
  missing_data: { en: "Missing data", ar: "بيانات ناقصة" },
  check_failed: { en: "Check failed", ar: "فشل الفحص" },
  permission_denied: { en: "No permission", ar: "لا توجد صلاحية" },
  missing_credentials: { en: "Missing credentials", ar: "بيانات الاعتماد ناقصة" },
};

const c = (en: string, ar: string): Copy => ({ en, ar });
const pick = (tx: Tx, x: Copy) => tx(x.en, x.ar);

// ─── Value labels and tones (ported from Tkana's health page) ───────────────

const QUALITY: Record<string, [Copy, Tone]> = {
  GREEN: [c("High", "عالية"), "good"],
  YELLOW: [c("Medium", "متوسطة"), "warn"],
  RED: [c("Low", "منخفضة"), "bad"],
  NOT_RATED: [c("Not rated yet", "لم تُقيَّم بعد"), "neutral"],
};

const MESSAGING: Record<string, [Copy, Tone]> = {
  AVAILABLE: [c("Can send", "يمكن الإرسال"), "good"],
  LIMITED: [c("Limited", "محدودة"), "warn"],
  BLOCKED: [c("Blocked", "محظورة"), "bad"],
};

const NAME: Record<string, [Copy, Tone]> = {
  APPROVED: [c("Approved", "معتمد"), "good"],
  AVAILABLE_WITHOUT_REVIEW: [c("Available without review", "متاح دون مراجعة"), "good"],
  PENDING_REVIEW: [c("In review", "قيد المراجعة"), "warn"],
  DECLINED: [c("Declined", "مرفوض"), "bad"],
  EXPIRED: [c("Expired", "منتهي الصلاحية"), "bad"],
  NONE: [c("Not submitted", "لم يُقدَّم"), "neutral"],
};

const VERIFIED: Record<string, [Copy, Tone]> = {
  VERIFIED: [c("Verified", "موثّق"), "good"],
  NOT_VERIFIED: [c("Not verified", "غير موثّق"), "warn"],
  REJECTED: [c("Rejected", "مرفوض"), "bad"],
  EXPIRED: [c("Expired", "منتهي الصلاحية"), "bad"],
  FAILED: [c("Failed", "فشل"), "bad"],
  INELIGIBLE: [c("Not eligible", "غير مؤهَّل"), "warn"],
  REVOKED: [c("Revoked", "مسحوب"), "bad"],
};

const CODE: Record<string, [Copy, Tone]> = {
  VERIFIED: [c("Verified", "تم التحقق"), "good"],
  UNVERIFIED: [c("Not verified", "لم يتم التحقق"), "warn"],
  NOT_VERIFIED: [c("Not verified", "لم يتم التحقق"), "warn"],
  EXPIRED: [c("Expired", "منتهي الصلاحية"), "warn"],
};

const REVIEW: Record<string, [Copy, Tone]> = {
  APPROVED: [c("Approved", "مقبولة"), "good"],
  DEFERRED: [c("Deferred", "مؤجّلة"), "warn"],
  PENDING: [c("In review", "قيد المراجعة"), "warn"],
  REJECTED: [c("Rejected", "مرفوضة"), "bad"],
};

const PHONE: Record<string, [Copy, Tone]> = {
  CONNECTED: [c("Connected", "متصل"), "good"],
  PENDING: [c("Pending", "قيد الانتظار"), "warn"],
  FLAGGED: [c("Flagged", "عليه تنبيه"), "warn"],
  RATE_LIMITED: [c("Rate limited", "محدود المعدّل"), "warn"],
  RESTRICTED: [c("Restricted", "مقيّد"), "bad"],
  BANNED: [c("Banned", "محظور"), "bad"],
  DISCONNECTED: [c("Disconnected", "مفصول"), "bad"],
  DELETED: [c("Deleted", "محذوف"), "bad"],
  MIGRATED: [c("Migrated", "منقول"), "neutral"],
  UNVERIFIED: [c("Not verified", "لم يتم التحقق"), "warn"],
};

/** "SOME_VALUE" → "Some value" (open-ended provider values we have no copy for). */
function humanize(v: string): string {
  const s = v.toLowerCase().replace(/_/g, " ").trim();
  return s ? s[0]!.toUpperCase() + s.slice(1) : v;
}

export function qualityTone(v: string | null | undefined): Tone {
  return (v && QUALITY[v]?.[1]) || "neutral";
}

export function nameTone(v: string | null | undefined): Tone {
  return (v && NAME[v]?.[1]) || "neutral";
}

export function reviewTone(v: string | null | undefined): Tone {
  return (v && REVIEW[v]?.[1]) || "neutral";
}

function phoneEntry(v: string): [Copy, Tone] {
  const known = PHONE[v];
  if (known) return known;
  if (v.startsWith("MESSAGING_LIMIT")) return [c("Messaging limited", "المراسلة محدودة"), "warn"];
  const h = humanize(v);
  return [c(h, h), "neutral"];
}

function pendingVerified(v: string): [Copy, Tone] | null {
  return /^PENDING/.test(v) ? [c("In review", "قيد المراجعة"), "warn"] : null;
}

// ─── Tier ──────────────────────────────────────────────────────────────────

const TIER_CAPS: Record<string, number> = {
  TIER_50: 50,
  TIER_250: 250,
  TIER_1K: 1_000,
  TIER_2K: 2_000,
  TIER_10K: 10_000,
  TIER_100K: 100_000,
};

export interface TierView {
  label: string;
  /** Daily cap; Infinity for unlimited; null when not a cap (not set, unknown, unrecognised). */
  cap: number | null;
  /** R14: the limit is shared by every number in the business. */
  note: string;
}

/** `TIER_2K` → "2,000 / day"; `TIER_UNLIMITED` → "Unlimited"; digits pass through. */
export function tierView(value: string | null | undefined, tx: Tx): TierView {
  const note = pick(tx, TIER_SHARED_NOTE);
  const v = value ?? UNKNOWN;
  if (v === UNKNOWN) return { label: pick(tx, UNKNOWN_LABEL), cap: null, note };
  if (v === "TIER_UNLIMITED") return { label: tx("Unlimited", "غير محدود"), cap: Number.POSITIVE_INFINITY, note };
  if (v === "TIER_NOT_SET") return { label: tx("Not set yet", "لم يُحدَّد بعد"), cap: null, note };
  const cap = /^\d+$/.test(v) ? Number(v) : (TIER_CAPS[v] ?? null);
  if (cap === null) return { label: v, cap: null, note };
  const n = cap.toLocaleString("en-US");
  return { label: tx(`${n} / day`, `${n} / يوم`), cap, note };
}

// ─── Signals ───────────────────────────────────────────────────────────────

export interface SignalView {
  label: string;
  tone: Tone;
  unknown: boolean;
  state: ValueState;
  /** Why it is unknown (tooltip / small print). */
  reason?: string;
  /** The last value seen before a failed read; shown labelled as previous, never as current. */
  previous?: { label: string; at: string };
  /** R1: the value (or the previous one) came through an undocumented Zernio field. */
  source?: string;
}

/** A known value of a field → label and tone. */
export function valueView(name: HealthFieldName, value: string, tx: Tx): { label: string; tone: Tone } {
  let e: [Copy, Tone] | null | undefined;
  switch (name) {
    case "quality":
      e = QUALITY[value];
      break;
    case "tier":
      return { label: tierView(value, tx).label, tone: "neutral" };
    case "messaging":
      e = MESSAGING[value];
      break;
    case "nameStatus":
      e = NAME[value];
      break;
    case "verified":
      e = VERIFIED[value] ?? pendingVerified(value);
      break;
    case "codeVerification":
      e = CODE[value];
      break;
    case "phoneStatus":
      e = phoneEntry(value);
      break;
    case "accountReview":
      e = REVIEW[value];
      break;
  }
  if (!e) {
    const h = humanize(value);
    return { label: h, tone: "neutral" };
  }
  return { label: pick(tx, e[0]), tone: e[1] };
}

/** The reason copy for an unknown value. `previous` names the last value seen. */
export function unknownReason(error: HealthSignalError | undefined, tx: Tx, previous?: string): string {
  switch (error) {
    case "unsupported":
      return tx("This provider doesn't report it", "هذا المزوّد لا يوفّر هذه المعلومة");
    case "check_failed":
      return previous
        ? tx(`Couldn't check — last seen ${previous}`, `تعذّر الفحص — آخر قيمة ${previous}`)
        : tx("Couldn't check", "تعذّر الفحص");
    case "permission_denied":
      return previous
        ? tx(`Meta refused access to this field — last seen ${previous}`, `رفضت Meta الوصول إلى هذا الحقل — آخر قيمة ${previous}`)
        : tx("Meta refused access to this field", "رفضت Meta الوصول إلى هذا الحقل");
    case "missing_data":
      return previous
        ? tx(`The provider answered without a usable value — last seen ${previous}`, `ردّ المزوّد دون قيمة صالحة — آخر قيمة ${previous}`)
        : tx("The provider answered without a usable value", "ردّ المزوّد دون قيمة صالحة");
    case "missing_credentials":
      return tx("The connection has no credentials to check this", "لا يملك الربط بيانات اعتماد لفحص هذا");
    default:
      return tx("Not checked yet", "لم يُفحص بعد");
  }
}

/**
 * One health field for display. Unknown is "Unknown" / "غير معروف", tone
 * neutral, with the reason; a `lastKnown` value comes back as `previous`.
 */
export function signalView(
  name: HealthFieldName,
  signal: HealthSignal | null | undefined,
  tx: Tx,
  lastKnown?: { value: string; checkedAt: string; source?: string } | null,
): SignalView {
  const value = signal?.value;
  if (signal && typeof value === "string" && value && value !== UNKNOWN) {
    const v = valueView(name, value, tx);
    return {
      label: v.label,
      tone: v.tone,
      unknown: false,
      state: "real",
      ...(signal.source === "zernio_passthrough" ? { source: pick(tx, SOURCE_LABEL) } : {}),
    };
  }
  const error = signal?.error ?? null;
  const prev = lastKnown && lastKnown.value && lastKnown.value !== UNKNOWN ? lastKnown : null;
  const prevLabel = prev ? valueView(name, prev.value, tx).label : undefined;
  return {
    label: pick(tx, UNKNOWN_LABEL),
    tone: "neutral",
    unknown: true,
    state: error ?? "not_checked",
    reason: unknownReason(error, tx, prevLabel),
    ...(prev && prevLabel ? { previous: { label: prevLabel, at: prev.checkedAt } } : {}),
    ...(prev?.source === "zernio_passthrough" ? { source: pick(tx, SOURCE_LABEL) } : {}),
  };
}

/** The templates field: the paused + disabled count ("templates needing review"). */
export function templatesView(t: HealthTemplatesSignal | null | undefined, tx: Tx): SignalView & { bad: number | null } {
  const v = t?.value;
  if (!t || !v || v === UNKNOWN || typeof v !== "object") {
    const error = t?.error ?? null;
    return {
      label: pick(tx, UNKNOWN_LABEL),
      tone: "neutral",
      unknown: true,
      state: error ?? "not_checked",
      reason: unknownReason(error, tx),
      bad: null,
    };
  }
  const bad = v.paused + v.disabled;
  // Final review M2: with nothing paused or disabled, "None" would also claim
  // the quality is fine. When the provider did not report it (or the
  // snapshot predates the count), the honest answer is Unknown.
  if (v.total > 0 && bad === 0 && v.lowQuality === 0 && (v.qualityUnknown === undefined || v.qualityUnknown > 0)) {
    return {
      label: pick(tx, UNKNOWN_LABEL),
      tone: "neutral",
      unknown: true,
      state: "missing_data",
      reason: tx(
        "Template quality isn't reported by the provider. None are paused or disabled.",
        "لا يُبلِّغ المزوّد عن جودة القوالب. لا توجد قوالب متوقفة أو معطّلة.",
      ),
      bad: 0,
    };
  }
  const parts: string[] = [];
  if (v.paused) parts.push(tx(`${v.paused} paused`, `${v.paused} متوقف مؤقتًا`));
  if (v.disabled) parts.push(tx(`${v.disabled} disabled`, `${v.disabled} معطّل`));
  if (v.lowQuality) parts.push(tx(`${v.lowQuality} low quality`, `${v.lowQuality} منخفض الجودة`));
  const label =
    v.total === 0
      ? tx("No templates", "لا توجد قوالب")
      : parts.length
        ? parts.join(" · ")
        : tx(`None (${v.total} templates)`, `لا شيء (${v.total} قالب)`);
  const tone: Tone = v.disabled > 0 ? "bad" : v.paused > 0 || v.lowQuality > 0 ? "warn" : v.total === 0 ? "neutral" : "good";
  return { label, tone, unknown: false, state: "real", bad };
}

// ─── Overall and issues ────────────────────────────────────────────────────

export const OVERALL_COPY: Record<HealthOverall, [Copy, Tone]> = {
  healthy: [c("Healthy", "سليم"), "good"],
  attention: [c("Needs attention", "يحتاج إلى انتباه"), "warn"],
  critical: [c("Critical", "حرج"), "bad"],
  unknown: [c("Unknown", "غير معروف"), "neutral"],
};

/** The overall chip. No snapshot yet reads "Not checked yet", never healthy. */
export function overallView(health: Pick<ChannelHealthPublic, "overall"> | null | undefined, tx: Tx): { label: string; tone: Tone } {
  if (!health) return { label: tx("Not checked yet", "لم يُفحص بعد"), tone: "neutral" };
  const e = OVERALL_COPY[health.overall] ?? OVERALL_COPY.unknown;
  return { label: pick(tx, e[0]), tone: e[1] };
}

/** Every fixed issue key the backend emits (`computeIssues`). */
export const ISSUE_COPY: Record<string, Copy> = {
  quality_red: c("Quality rating is low. Messages may be limited soon.", "تقييم الجودة منخفض. قد تُقيَّد الرسائل قريبًا."),
  quality_yellow: c("Quality rating is medium.", "تقييم الجودة متوسط."),
  messaging_blocked: c("This number can't send messages.", "لا يستطيع هذا الرقم إرسال الرسائل."),
  messaging_limited: c("Messaging from this number is limited.", "المراسلة من هذا الرقم محدودة."),
  name_declined: c("Meta declined the display name.", "رفضت Meta الاسم الظاهر."),
  name_expired: c("The display name approval expired.", "انتهت صلاحية اعتماد الاسم الظاهر."),
  name_pending: c("The display name is in review.", "الاسم الظاهر قيد المراجعة."),
  account_review_rejected: c("Meta rejected the account review.", "رفضت Meta مراجعة الحساب."),
  templates_paused: c("Some templates are paused.", "بعض القوالب متوقفة مؤقتًا."),
  templates_disabled: c("Some templates are disabled.", "بعض القوالب معطّلة."),
  templates_low_quality: c("Some templates have low quality.", "بعض القوالب منخفضة الجودة."),
  check_incomplete: c("Some values couldn't be checked.", "تعذّر فحص بعض القيم."),
};

/** Copy for one issue key, including `phone_status_<lower>` and `verification_<lower>`. */
export function issueText(key: string, tx: Tx): string {
  const fixed = ISSUE_COPY[key];
  if (fixed) return pick(tx, fixed);
  let m = /^phone_status_([a-z0-9_]+)$/.exec(key);
  if (m) {
    const label = valueView("phoneStatus", m[1]!.toUpperCase(), tx).label;
    return tx(`Phone status: ${label}.`, `حالة الرقم: ${label}.`);
  }
  m = /^verification_([a-z0-9_]+)$/.exec(key);
  if (m) {
    const label = valueView("verified", m[1]!.toUpperCase(), tx).label;
    return tx(`Business verification: ${label}.`, `توثيق النشاط التجاري: ${label}.`);
  }
  return tx("Something on this number needs a look.", "هناك ما يحتاج إلى مراجعة في هذا الرقم.");
}

export function issueTone(key: string): Tone {
  if (key === "check_incomplete") return "neutral";
  if (
    key === "quality_red" ||
    key === "messaging_blocked" ||
    key === "account_review_rejected" ||
    key === "name_declined" ||
    key === "templates_disabled" ||
    /^phone_status_(restricted|banned|disconnected)$/.test(key)
  ) {
    return "bad";
  }
  return "warn";
}

// ─── Live check cooldown ───────────────────────────────────────────────────

/** Whole seconds until `healthNextCheckAt`; 0 when none, past or unreadable. */
export function cooldownLeft(healthNextCheckAt: string | null | undefined, now: number | Date): number {
  if (!healthNextCheckAt) return 0;
  const at = Date.parse(healthNextCheckAt);
  if (!Number.isFinite(at)) return 0;
  const t = typeof now === "number" ? now : now.getTime();
  return Math.max(0, Math.ceil((at - t) / 1000));
}

/** The next-allowed instant from a 429 body (`nextAt`, else `retryAfter` seconds); null otherwise. */
export function nextCheckFromError(body: unknown, now: number): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { nextAt?: unknown; retryAfter?: unknown };
  if (typeof b.nextAt === "string" && Number.isFinite(Date.parse(b.nextAt))) return b.nextAt;
  const s = Number(b.retryAfter);
  if (Number.isFinite(s) && s > 0) return new Date(now + Math.ceil(s) * 1000).toISOString();
  return null;
}

/** The later of two instants (ISO); either may be null. */
export function laterOf(a: string | null | undefined, b: string | null | undefined): string | null {
  const ta = a ? Date.parse(a) : NaN;
  const tb = b ? Date.parse(b) : NaN;
  if (!Number.isFinite(ta)) return Number.isFinite(tb) ? b! : null;
  if (!Number.isFinite(tb)) return a!;
  return ta >= tb ? a! : b!;
}

/** "Check now", or "Check again in 0:42" while the cooldown runs. */
export function checkButtonLabel(secondsLeft: number, busy: boolean, tx: Tx): string {
  if (busy) return tx("Checking…", "جارٍ الفحص…");
  if (secondsLeft <= 0) return tx("Check now", "افحص الآن");
  const m = Math.floor(secondsLeft / 60);
  const s = String(secondsLeft % 60).padStart(2, "0");
  return tx(`Check again in ${m}:${s}`, `افحص مجددًا بعد ${m}:${s}`);
}

/** Which channels have number health: WhatsApp on Zernio or Meta. */
export function hasNumberHealth(c: Pick<ChannelDto, "kind" | "provider">): boolean {
  return c.kind === "whatsapp" && (c.provider === "zernio" || c.provider === "meta");
}

// ─── Templates ─────────────────────────────────────────────────────────────

const TEMPLATE_STATUS: Record<string, [Copy, Tone]> = {
  approved: [c("Approved", "معتمد"), "good"],
  pending: [c("Pending", "قيد المراجعة"), "warn"],
  submitted: [c("Submitted", "أُرسل للمراجعة"), "warn"],
  in_appeal: [c("In appeal", "قيد الاعتراض"), "warn"],
  rejected: [c("Rejected", "مرفوض"), "bad"],
  failed: [c("Failed", "فشل"), "bad"],
  paused: [c("Paused", "متوقف مؤقتًا"), "warn"],
  disabled: [c("Disabled", "معطّل"), "bad"],
  pending_deletion: [c("Being deleted", "قيد الحذف"), "neutral"],
  local: [c("Local only", "محلي فقط"), "neutral"],
  missing: [c("Not on this number", "غير موجود على هذا الرقم"), "neutral"],
  unknown: [c("Unknown", "غير معروف"), "neutral"],
};

/**
 * A template status (stored lowercase, or a number's Meta value in UPPERCASE),
 * plus "missing" (the number's list is known and lacks it) and "unknown".
 */
export function templateStatusView(status: string | null | undefined, tx: Tx): { label: string; tone: Tone; unknown: boolean } {
  const s = (status ?? "").trim().toLowerCase() || UNKNOWN;
  const e = TEMPLATE_STATUS[s];
  if (e) return { label: pick(tx, e[0]), tone: e[1], unknown: s === UNKNOWN };
  const h = humanize(s);
  return { label: h, tone: "neutral", unknown: false };
}

/** Template quality: GREEN/YELLOW/RED/NOT_RATED; null or "unknown" is Unknown. */
export function templateQualityView(q: string | null | undefined, tx: Tx): { label: string; tone: Tone; unknown: boolean } {
  const e = q ? QUALITY[q] : undefined;
  if (e) return { label: pick(tx, e[0]), tone: e[1], unknown: false };
  return { label: pick(tx, UNKNOWN_LABEL), tone: "neutral", unknown: true };
}

/** What the missing vs unknown rows in the health sheet mean. */
export const MISSING_VS_UNKNOWN: Copy = {
  en: "“Not on this number” means the number's template list was read and this template isn't in it. “Unknown” means the list hasn't been read yet, or the last read failed.",
  ar: "«غير موجود على هذا الرقم» يعني أن قائمة قوالب الرقم قُرئت ولا يوجد فيها هذا القالب. «غير معروف» يعني أن القائمة لم تُقرأ بعد، أو فشلت آخر قراءة.",
};

export type FullStatus = "approved" | "pending" | "rejected" | "local" | "paused" | "disabled";

/**
 * The Templates list status. `paused` and `disabled` stay distinct (they were
 * collapsed into `pending`, which hid pauses); `failed` reads as rejected; any
 * other value stays pending as before.
 */
export function toFullStatus(status: string | null | undefined): FullStatus {
  switch (status) {
    case "approved":
    case "pending":
    case "rejected":
    case "local":
    case "paused":
    case "disabled":
      return status;
    case "failed":
      return "rejected";
    default:
      return "pending";
  }
}

/** Tone → the Badge component's kind. */
export function badgeKind(tone: Tone): "" | "ok" | "warn" | "bad" {
  return tone === "good" ? "ok" : tone === "neutral" ? "" : tone;
}

// ─── Notification (channel.health_downgraded) ──────────────────────────────

export interface HealthChange {
  signal: string;
  from?: unknown;
  to?: unknown;
}

const plainCount = (n: number, tx: Tx): string => {
  const en = `${n} ${n === 1 ? "template" : "templates"} paused or disabled`;
  const ar =
    n === 1
      ? "تم إيقاف قالب أو تعطيله"
      : n === 2
        ? "تم إيقاف قالبين أو تعطيلهما"
        : n <= 10
          ? `تم إيقاف ${n} قوالب أو تعطيلها`
          : `تم إيقاف ${n} قالبًا أو تعطيلها`;
  return tx(en, ar);
};

/** One downgrade change, worded per signal ("quality dropped to Medium"). */
export function changeText(ch: HealthChange, tx: Tx): string {
  const to = typeof ch.to === "string" ? ch.to : typeof ch.to === "number" ? String(ch.to) : "";
  switch (ch.signal) {
    case "quality": {
      const l = to ? valueView("quality", to, tx).label : pick(tx, UNKNOWN_LABEL);
      return tx(`quality dropped to ${l}`, `انخفضت الجودة إلى ${l}`);
    }
    case "messaging":
      if (to === "BLOCKED") return tx("messaging is blocked", "المراسلة محظورة");
      if (to === "LIMITED") return tx("messaging is limited", "المراسلة محدودة");
      return tx("messaging changed", "تغيّرت حالة المراسلة");
    case "phoneStatus": {
      const l = to ? valueView("phoneStatus", to, tx).label : pick(tx, UNKNOWN_LABEL);
      return tx(`phone status is now ${l}`, `حالة الرقم الآن ${l}`);
    }
    case "nameStatus":
      if (to === "DECLINED") return tx("the display name was declined", "رُفض الاسم الظاهر");
      if (to === "EXPIRED") return tx("the display name expired", "انتهت صلاحية الاسم الظاهر");
      return tx("the display name status changed", "تغيّرت حالة الاسم الظاهر");
    case "accountReview":
      return to === "REJECTED"
        ? tx("the account review was rejected", "رُفضت مراجعة الحساب")
        : tx("the account review changed", "تغيّرت مراجعة الحساب");
    case "tier": {
      const l = tierView(to || UNKNOWN, tx).label;
      return tx(`the daily limit dropped to ${l}`, `انخفض الحد اليومي إلى ${l}`);
    }
    case "templatesBad": {
      const n = Number(ch.to);
      return Number.isFinite(n) && n > 0 ? plainCount(n, tx) : tx("templates were paused or disabled", "تم إيقاف قوالب أو تعطيلها");
    }
    default:
      return tx("its health changed", "تغيّرت حالته");
  }
}

// ─── SP-14 final review: sender chips, template list time, template quality ─

/** M1: a sender's tier / quality older than this reads as Unknown. */
export const SENDER_HEALTH_MAX_AGE_MS = 7 * 24 * 3_600_000;

export interface SenderChipsView {
  tier: { label: string; unknown: boolean; note: string };
  quality: { label: string; tone: Tone; unknown: boolean };
  /** When the values were read (ISO); null when they are not shown. */
  checkedAt: string | null;
  /** Why both chips are Unknown (no read, or one too old). */
  reason?: string;
}

/**
 * M1: the campaign sender chips. The values count only with a check time no
 * older than 7 days; otherwise both chips are Unknown with the reason. An
 * older backend that sends neither field gets no chips (null).
 */
export function senderChipsView(
  s: { tier?: string; quality?: string; healthCheckedAt?: string | null },
  nowMs: number,
  tx: Tx,
): SenderChipsView | null {
  if (s.tier === undefined && s.quality === undefined) return null;
  const at = s.healthCheckedAt ? Date.parse(s.healthCheckedAt) : NaN;
  const fresh = Number.isFinite(at) && nowMs - at <= SENDER_HEALTH_MAX_AGE_MS;
  const reason = fresh
    ? undefined
    : Number.isFinite(at)
      ? tx("Not checked in the last 7 days", "لم يُفحص خلال آخر 7 أيام")
      : tx("Not checked yet", "لم يُفحص بعد");
  const tierValue = fresh ? (s.tier ?? UNKNOWN) : UNKNOWN;
  const qualityValue = fresh ? (s.quality ?? UNKNOWN) : UNKNOWN;
  const t = tierView(tierValue, tx);
  const q = signalView("quality", { value: qualityValue, checkedAt: null, error: null }, tx);
  return {
    tier: { label: t.label, unknown: !tierValue || tierValue === UNKNOWN, note: t.note },
    quality: { label: q.label, tone: q.tone, unknown: q.unknown },
    checkedAt: fresh ? (s.healthCheckedAt ?? null) : null,
    ...(reason ? { reason } : {}),
  };
}

/**
 * M3: the time label of a number's template list. "Read" only when the list
 * was read; after a failed read the time is only the last attempt.
 */
export function templatesReadLabel(d: { known: boolean; checkedAt: string | null }, tx: Tx): string | null {
  if (!d.checkedAt) return null;
  return d.known ? tx("Read", "قُرئت") : tx("Last attempt", "آخر محاولة");
}

export interface TemplateQualityCell {
  label: string;
  tone: Tone;
  unknown: boolean;
  /** A stored score that no read confirms now: shown muted, as previous. */
  previous: boolean;
  /** R1: the score came through Zernio's undocumented passthrough. */
  source?: string;
  /** When the list carrying the score was read. */
  readAt?: string;
}

/**
 * M5: the Templates list quality cell. A score from a list read now shows
 * its source mark and read time. A stored score that no read confirms now
 * (`qualityReadAt: null`) is "Previous: …", muted, never current. An older
 * backend without the read fields shows the value as before.
 */
export function templateQualityCell(
  row: { quality?: string | null; qualitySource?: string | null; qualityReadAt?: string | null },
  tx: Tx,
): TemplateQualityCell {
  const q = templateQualityView(row.quality, tx);
  if (q.unknown) return { ...q, previous: false };
  if (row.qualityReadAt === null) {
    return { label: tx(`Previous: ${q.label}`, `السابق: ${q.label}`), tone: "neutral", unknown: true, previous: true };
  }
  return {
    ...q,
    previous: false,
    ...(row.qualitySource === "zernio_passthrough" ? { source: pick(tx, SOURCE_LABEL) } : {}),
    ...(row.qualityReadAt ? { readAt: row.qualityReadAt } : {}),
  };
}
