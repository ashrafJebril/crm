import type { BadgeKind } from "@/components/Badge";
import type { ChannelConfig, ChannelDto, ChannelLimits, VerificationStage } from "@/lib/types";

/**
 * Pure view logic for the channels hub (SP-19 T5). No React, no fetch: every
 * function here is unit-tested in channelModel.test.ts.
 */

/* ── Status ─────────────────────────────────────────────────────────────── */

export interface StatusBadge {
  tone: BadgeKind;
  en: string;
  ar: string;
}

const STATUS: Record<string, StatusBadge> = {
  active: { tone: "ok", en: "Active", ar: "نشطة" },
  needs_attention: { tone: "warn", en: "Needs attention", ar: "تحتاج انتباهًا" },
  pending: { tone: "info", en: "Pending", ar: "قيد الانتظار" },
  error: { tone: "bad", en: "Error", ar: "خطأ" },
  disconnected: { tone: "", en: "Disconnected", ar: "مفصولة" },
};

export function statusBadge(status: string): StatusBadge {
  return STATUS[status] ?? { tone: "warn", en: status || "Unknown", ar: "غير معروفة" };
}

/* ── Kinds ──────────────────────────────────────────────────────────────── */

export const KIND_ORDER = ["whatsapp", "facebook", "instagram", "tiktok", "telegram", "webchat"];

export const KIND_LABEL: Record<string, { en: string; ar: string; color: string }> = {
  whatsapp: { en: "WhatsApp", ar: "واتساب", color: "#25D366" },
  facebook: { en: "Facebook", ar: "فيسبوك", color: "#1877F2" },
  instagram: { en: "Instagram", ar: "إنستغرام", color: "#E1306C" },
  tiktok: { en: "TikTok", ar: "تيك توك", color: "#000000" },
  telegram: { en: "Telegram", ar: "تيليجرام", color: "#229ED9" },
  webchat: { en: "Website chat", ar: "دردشة الموقع", color: "#5A8FD4" },
};

export function kindLabel(kind: string): { en: string; ar: string; color: string } {
  return KIND_LABEL[kind] ?? { en: kind ? kind[0]!.toUpperCase() + kind.slice(1) : "—", ar: kind || "—", color: "#7a7a7a" };
}

export const PROVIDER_LABEL: Record<string, { en: string; ar: string }> = {
  zernio: { en: "via Zernio", ar: "عبر Zernio" },
  meta: { en: "Meta Cloud API", ar: "Meta Cloud API" },
  telegram: { en: "Telegram Bot API", ar: "Telegram Bot API" },
  native: { en: "Built in", ar: "مدمجة" },
};

/* ── Grouping ───────────────────────────────────────────────────────────── */

export interface ChannelGroup {
  kind: string;
  channels: ChannelDto[];
}

export interface GroupedChannels {
  groups: ChannelGroup[];
  /** Disconnected channels, shown in their own collapsed section. */
  disconnected: ChannelDto[];
  total: number;
}

const byDefaultThenNewest = (a: ChannelDto, b: ChannelDto) =>
  Number(b.isDefault) - Number(a.isDefault) || a.createdAt.localeCompare(b.createdAt);

export function groupChannels(list: ChannelDto[]): GroupedChannels {
  const live = new Map<string, ChannelDto[]>();
  const disconnected: ChannelDto[] = [];
  for (const c of list) {
    if (c.status === "disconnected") {
      disconnected.push(c);
      continue;
    }
    const arr = live.get(c.kind) ?? [];
    arr.push(c);
    live.set(c.kind, arr);
  }
  const rank = (k: string) => {
    const i = KIND_ORDER.indexOf(k);
    return i < 0 ? KIND_ORDER.length : i;
  };
  const groups = [...live.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([kind, channels]) => ({ kind, channels: [...channels].sort(byDefaultThenNewest) }));
  disconnected.sort((a, b) => a.kind.localeCompare(b.kind) || a.displayName.localeCompare(b.displayName));
  return { groups, disconnected, total: list.length };
}

/* ── Actions ────────────────────────────────────────────────────────────── */

/** M-d: Zernio stopped listing the account; a sync may bring it back. */
export const needsSync = (c: ChannelDto) => c.statusReason === "zernio_account_missing";

export const canMakeDefault = (c: ChannelDto) => c.status === "active" && !c.isDefault;

export function verificationStage(config: ChannelConfig | null | undefined): VerificationStage | null {
  const s = config?.verification?.stage;
  return s === "needs_number" || s === "awaiting_code" || s === "needs_registration" ? s : null;
}

/**
 * Reconnect is offered where `POST /channels/:id/reconnect` has a hook:
 * telegram, meta, zernio (resync and revive, else Zernio's OAuth link) and
 * native web chat (revive a disconnected one). A landline row is driven by
 * its card; legacy providers (e.g. kapso) have no hook.
 */
export function canReconnect(c: ChannelDto): boolean {
  if (verificationStage(c.config)) return false;
  if (c.statusReason === "merged") return false;
  const repairable =
    c.status !== "active" ||
    c.statusReason === "meta_register_failed" ||
    c.statusReason === "meta_subscribe_failed";
  if (!repairable) return false;
  if (c.provider === "native") return c.status === "disconnected";
  return c.provider === "telegram" || c.provider === "meta" || c.provider === "zernio";
}

/* ── Web chat: snippet, hosted page, origins ─────────────────────────────── */

/** The backend's public origin from the client's API base (`…/api`). */
export function apiOriginFrom(apiBase: string, pageOrigin: string): string {
  let url: URL;
  try {
    url = new URL(apiBase, pageOrigin);
  } catch {
    return pageOrigin;
  }
  const path = url.pathname.replace(/\/+$/, "").replace(/\/api$/, "");
  return `${url.origin}${path}`;
}

/**
 * The origin the widget snippet and the hosted chat link use (m1): the
 * backend's `publicBaseUrl` from GET /channels/limits when it is a valid
 * http(s) URL, else the client's API base.
 */
export function publicOrigin(publicBaseUrl: string | null | undefined, apiBase: string, pageOrigin: string): string {
  if (publicBaseUrl) {
    try {
      const u = new URL(publicBaseUrl);
      if (u.protocol === "https:" || u.protocol === "http:") return u.origin;
    } catch {
      /* fall back */
    }
  }
  return apiOriginFrom(apiBase, pageOrigin);
}

const escapeAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The exact embed tag (T3 contract): `<script src="{API}/api/widget.js" data-channel="…" async></script>`. */
export function buildSnippet(apiOrigin: string, channelId: string, lang?: "en" | "ar" | null): string {
  const src = `${apiOrigin.replace(/\/+$/, "")}/api/widget.js`;
  const langAttr = lang === "en" || lang === "ar" ? ` data-lang="${lang}"` : "";
  return `<script src="${escapeAttr(src)}" data-channel="${escapeAttr(channelId)}"${langAttr} async></script>`;
}

/** The public hosted chat page (`{API}/api/chat/{id}`). */
export function chatPageUrl(apiOrigin: string, channelId: string, lang?: "en" | "ar" | null): string {
  const base = `${apiOrigin.replace(/\/+$/, "")}/api/chat/${encodeURIComponent(channelId)}`;
  return lang === "en" || lang === "ar" ? `${base}?lang=${lang}` : base;
}

export interface OriginOptions {
  production: boolean;
}

export type OriginResult = { ok: true; value: string } | { ok: false };

// Mirrors backend/src/channels/webchat/origin-match.ts normalizeOriginPattern.
const PATTERN_RE = /^(https?):\/\/(\*\.)?([a-z0-9.-]+)(?::(\d{1,5}|\*))?$/;
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);
const DEFAULT_PORT: Record<string, string> = { https: "443", http: "80" };

export const MAX_ALLOWED_ORIGINS = 20;
export const MAX_GREETING = 280;
export const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** Validate and normalize one allowed-origin pattern exactly as the backend does. */
export function validateOrigin(raw: string, opts: OriginOptions): OriginResult {
  const s = raw.trim().toLowerCase();
  if (!s || s.length > 300) return { ok: false };
  const m = PATTERN_RE.exec(s);
  if (!m) return { ok: false };
  const [, scheme, star, host, portRaw] = m as unknown as [string, string, string | undefined, string, string | undefined];
  if (host.length > 253 || !host.split(".").every((l) => LABEL_RE.test(l))) return { ok: false };
  let port = portRaw ?? "";
  if (port && port !== "*") {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return { ok: false };
    port = String(n) === DEFAULT_PORT[scheme] ? "" : String(n);
  }
  const wildcard = !!star;
  if (scheme === "http") {
    if (opts.production || wildcard || !LOCAL_HOSTS.has(host)) return { ok: false };
  } else {
    if (port === "*") return { ok: false };
    if (wildcard && host.split(".").length < 2) return { ok: false };
  }
  return { ok: true, value: `${scheme}://${wildcard ? "*." : ""}${host}${port ? `:${port}` : ""}` };
}

export interface WebchatForm {
  allowedOrigins: string[];
  greeting: string;
  greetingAr: string;
  color: string;
  position: "start" | "end";
  askName: boolean;
  lang: "en" | "ar" | null;
}

export interface WebchatConfigOut {
  allowedOrigins: string[];
  greeting: string | null;
  greetingAr: string | null;
  color: string | null;
  position: "start" | "end";
  askName: boolean;
  lang: "en" | "ar" | null;
}

export type WebchatErrors = Partial<Record<keyof WebchatForm, true | { index: number }>>;

/** Client mirror of the backend's `validateWebchatConfig` table. Empty strings clear a field. */
export function validateWebchatForm(
  form: WebchatForm,
  opts: OriginOptions,
): { config: WebchatConfigOut; errors: WebchatErrors } {
  const errors: WebchatErrors = {};
  const origins: string[] = [];
  const rawOrigins = form.allowedOrigins.map((o) => o.trim()).filter(Boolean);
  if (rawOrigins.length > MAX_ALLOWED_ORIGINS) errors.allowedOrigins = true;
  else {
    for (let i = 0; i < rawOrigins.length; i++) {
      const r = validateOrigin(rawOrigins[i]!, opts);
      if (!r.ok) {
        errors.allowedOrigins = { index: form.allowedOrigins.findIndex((o) => o.trim() === rawOrigins[i]) };
        break;
      }
      if (!origins.includes(r.value)) origins.push(r.value);
    }
  }
  const greeting = form.greeting.trim();
  const greetingAr = form.greetingAr.trim();
  if (greeting.length > MAX_GREETING) errors.greeting = true;
  if (greetingAr.length > MAX_GREETING) errors.greetingAr = true;
  const color = form.color.trim();
  if (color && !COLOR_RE.test(color)) errors.color = true;
  if (form.position !== "start" && form.position !== "end") errors.position = true;
  if (typeof form.askName !== "boolean") errors.askName = true;
  if (form.lang !== null && form.lang !== "en" && form.lang !== "ar") errors.lang = true;
  return {
    errors,
    config: {
      allowedOrigins: origins,
      greeting: greeting || null,
      greetingAr: greetingAr || null,
      color: color || null,
      position: form.position,
      askName: form.askName,
      lang: form.lang,
    },
  };
}

export function webchatFormFrom(config: ChannelConfig | null | undefined): WebchatForm {
  return {
    allowedOrigins: [...(config?.allowedOrigins ?? [])],
    greeting: config?.greeting ?? "",
    greetingAr: config?.greetingAr ?? "",
    color: config?.color ?? "",
    position: config?.position === "start" ? "start" : "end",
    askName: config?.askName === true,
    lang: config?.lang === "en" || config?.lang === "ar" ? config.lang : null,
  };
}

/* ── WhatsApp number limit ──────────────────────────────────────────────── */

export function limitState(limits: Pick<ChannelLimits, "whatsapp"> | null | undefined): "ok" | "at_limit" {
  const w = limits?.whatsapp;
  if (!w || !Number.isFinite(w.limit)) return "ok";
  return w.used >= w.limit ? "at_limit" : "ok";
}

const PLAN: Record<string, { en: string; ar: string }> = {
  free: { en: "Free", ar: "المجانية" },
  starter: { en: "Starter", ar: "المبتدئة" },
  growth: { en: "Growth", ar: "النمو" },
  pro: { en: "Pro", ar: "الاحترافية" },
};

export interface LimitView {
  state: "ok" | "at_limit";
  used: number;
  limit: number;
  percent: number;
  en: string;
  ar: string;
}

export function limitView(limits: Pick<ChannelLimits, "whatsapp"> | null | undefined): LimitView | null {
  const w = limits?.whatsapp;
  if (!w) return null;
  const plan = PLAN[w.plan?.toLowerCase?.() ?? ""] ?? { en: w.plan || "current", ar: w.plan || "الحالية" };
  const percent = w.limit > 0 ? Math.min(100, (w.used / w.limit) * 100) : 100;
  return {
    state: limitState(limits),
    used: w.used,
    limit: w.limit,
    percent,
    en: `${w.used} of ${w.limit} WhatsApp ${w.limit === 1 ? "number" : "numbers"} used (${plan.en} plan)`,
    ar: `${w.used} من ${w.limit} من أرقام واتساب مستخدمة (الباقة ${plan.ar})`,
  };
}

/* ── Landline verification ──────────────────────────────────────────────── */

export interface LandlineView {
  stage: VerificationStage;
  step: "number" | "code" | "register";
  phone: string | null;
  secondsLeft: number;
  canRequestCode: boolean;
}

/**
 * The landline card's state. `resendOverride` is a `resendAt` from a 429
 * `landline_cooldown` body, used when it is later than the stored one.
 */
export function landlineView(c: ChannelDto, now: number, resendOverride?: string | null): LandlineView | null {
  const stage = verificationStage(c.config);
  if (!stage) return null;
  const step = stage === "needs_number" ? "number" : stage === "awaiting_code" ? "code" : "register";
  const times = [c.config?.verification?.resendAt, resendOverride]
    .map((t) => (t ? Date.parse(t) : NaN))
    .filter((t) => Number.isFinite(t));
  const resendAt = times.length ? Math.max(...times) : 0;
  const secondsLeft = resendAt > now ? Math.ceil((resendAt - now) / 1000) : 0;
  return { stage, step, phone: c.phoneNumber, secondsLeft, canRequestCode: step === "code" && secondsLeft === 0 };
}
