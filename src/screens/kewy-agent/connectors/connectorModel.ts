import type { ConnectorCard, ConnectorRescanResult, ConnectorStatus, ConnectorSummary, ConnectorTool, ConnectorToolAccess } from "@/lib/types";
import type { Tx } from "@/lib/tx";

// ── catalog ────────────────────────────────────────────────────────────

/** Mirrors backend/src/connectors/connector-catalog.ts (a test pins equality). */
export const CONNECTOR_PROVIDER_KEYS = ["calendly", "hubspot", "pipedrive", "salla", "foodics", "custom"] as const;

/** A two-letter mark and a hue per provider (no third-party logos bundled). */
export const PROVIDER_MARK: Record<string, { mark: string; hue: number }> = {
  calendly: { mark: "Ca", hue: 220 },
  hubspot: { mark: "Hs", hue: 25 },
  pipedrive: { mark: "Pd", hue: 140 },
  salla: { mark: "Sa", hue: 170 },
  foodics: { mark: "Fo", hue: 280 },
  custom: { mark: "{}", hue: 260 },
};

export const CONNECTORS_TAB_HREF = "#/agent?tab=connectors";
export const connectorHref = (id: string) => `#/agent?tab=connectors&connector=${encodeURIComponent(id)}`;

// ── tools ──────────────────────────────────────────────────────────────

/** Mirror of the backend exposure rule (connector-tools.ts `isExposed`). */
export function isExposed(t: Pick<ConnectorTool, "access" | "kind" | "removed">): boolean {
  if (t.access === "off" || t.removed) return false;
  return t.access === "write" || t.kind === "read";
}

export function kindBadge(kind: "read" | "write", tx: Tx): { text: string; tone: "info" | "warn" } {
  return kind === "read" ? { text: tx("Read", "قراءة"), tone: "info" } : { text: tx("Makes changes", "يُجري تغييرات"), tone: "warn" };
}

export type Can = (p: "connectors.view" | "connectors.create" | "connectors.update" | "connectors.delete" | "connectors.manage") => boolean;

export interface SwitchState {
  /** The access the switch turns ON to (read for read tools, write for write tools). */
  onAccess: ConnectorToolAccess;
  on: boolean;
  disabled: boolean;
  reason: "removed" | "no_permission" | "needs_manage" | "inactive" | null;
  /** Turning it on lets the agent change data on its own: confirm first. */
  needsConfirm: boolean;
}

/**
 * One tool's switch for the viewer. Read tools switch to "read" with
 * connectors.update; write tools switch to "write", which also needs
 * connectors.manage (ruling 11); switching OFF never needs manage.
 */
export function switchState(tool: ConnectorTool, can: Can, status: ConnectorStatus): SwitchState {
  const onAccess: ConnectorToolAccess = tool.kind === "write" ? "write" : "read";
  const on = isExposed(tool);
  const base = { onAccess, on, needsConfirm: !on && tool.kind === "write" };
  if (tool.removed) return { ...base, disabled: true, reason: "removed" };
  if (status === "disconnected") return { ...base, disabled: true, reason: "inactive" };
  if (!can("connectors.update")) return { ...base, disabled: true, reason: "no_permission" };
  if (!on && tool.kind === "write" && !can("connectors.manage")) return { ...base, disabled: true, reason: "needs_manage" };
  return { ...base, disabled: false, reason: null };
}

export function switchReasonText(reason: SwitchState["reason"], tx: Tx): string | null {
  switch (reason) {
    case "removed":
      return tx("Removed by the provider", "أزالها المزوّد");
    case "no_permission":
      return tx("You can view tools but not change them.", "يمكنك عرض الأدوات دون تعديلها.");
    case "needs_manage":
      return tx("Only the owner or an admin can let the agent make changes.", "يمكن للمالك أو المسؤول فقط السماح للوكيل بإجراء تغييرات.");
    case "inactive":
      return tx("Reconnect to change tools.", "أعد الربط لتعديل الأدوات.");
    default:
      return null;
  }
}

export function writeWarning(connectorName: string, tx: Tx): string {
  return tx(`The agent will be able to change data in ${connectorName} on its own.`, `سيتمكن الوكيل من تعديل البيانات في ${connectorName} بنفسه.`);
}

/** Why a re-scan switched the tool off (shown until switched on again). */
export function flagText(flag: ConnectorTool["flag"], tx: Tx): string | null {
  switch (flag) {
    case "reclassified":
      return tx(
        "Switched off for safety: the provider changed whether this tool only reads or makes changes. Review it before switching it on again.",
        "أُوقفت للسلامة: غيّر المزوّد ما إذا كانت هذه الأداة تقرأ فقط أم تُجري تغييرات. راجعها قبل تفعيلها مجددًا.",
      );
    case "description_changed":
      return tx(
        "Switched off for safety: the provider changed this tool's description. Review it before switching it on again.",
        "أُوقفت للسلامة: غيّر المزوّد وصف هذه الأداة. راجعها قبل تفعيلها مجددًا.",
      );
    case "schema_changed":
      return tx(
        "Switched off for safety: the provider changed what this tool accepts. Review it before switching it on again.",
        "أُوقفت للسلامة: غيّر المزوّد مدخلات هذه الأداة. راجعها قبل تفعيلها مجددًا.",
      );
    default:
      return null;
  }
}

// ── cards, status, banner, notices ─────────────────────────────────────

export type CardKind = "available" | "coming_soon" | "not_configured";

export function cardKind(card: Pick<ConnectorCard, "available" | "unavailableReason">): CardKind {
  if (card.available) return "available";
  return card.unavailableReason === "coming_soon" ? "coming_soon" : "not_configured";
}

export function cardKindText(kind: CardKind, tx: Tx): string | null {
  if (kind === "coming_soon") return tx("Coming soon", "قريبًا");
  if (kind === "not_configured") return tx("Not configured on this server", "غير مُعدّ على هذا الخادم");
  return null;
}

export function statusText(status: ConnectorStatus, tx: Tx): { text: string; tone: "ok" | "warn" | "bad" | "" } {
  switch (status) {
    case "active":
      return { text: tx("Connected", "متصل"), tone: "ok" };
    case "needs_reconnect":
      return { text: tx("Needs reconnecting", "يحتاج إعادة ربط"), tone: "bad" };
    case "pending":
      return { text: tx("Not finished", "لم يكتمل"), tone: "warn" };
    default:
      return { text: tx("Disconnected", "مفصول"), tone: "" };
  }
}

/** The attention banner: one line per connector that needs reconnecting. */
export function attentionLines(list: ConnectorSummary[], tx: Tx): { id: string; provider: string; text: string }[] {
  return list
    .filter((c) => c.status === "needs_reconnect")
    .map((c) => ({ id: c.id, provider: c.provider, text: tx(`${c.name} needs reconnecting`, `يحتاج ${c.name} إلى إعادة الربط`) }));
}

/** The notice after a re-scan (tool names are shown as-is, inside <bdi>). */
export function rescanNotice(r: Pick<ConnectorRescanResult, "added" | "removed" | "changed">, tx: Tx): string[] {
  const out: string[] = [];
  if (r.added.length) out.push(tx(`New tools (switched off): ${r.added.join(", ")}`, `أدوات جديدة (متوقفة): ${r.added.join("، ")}`));
  if (r.removed.length) out.push(tx(`Removed by the provider: ${r.removed.join(", ")}`, `أزالها المزوّد: ${r.removed.join("، ")}`));
  if (r.changed.length) out.push(tx(`Changed by the provider: ${r.changed.join(", ")}`, `غيّرها المزوّد: ${r.changed.join("، ")}`));
  if (!out.length) out.push(tx("No changes: the tools are up to date.", "لا تغييرات: الأدوات محدّثة."));
  return out;
}

// ── OAuth popup ────────────────────────────────────────────────────────
//
// Review M2 (reverse tab-nabbing): the popup is opened with `noopener`, so
// no page in it (the vendor's included) can reach this tab. The backend
// callback page then has no opener and redirects the popup to the frontend
// (`#/agent?tab=connectors&connected=…`); the app loading there, same origin
// as this tab, relays the result on a BroadcastChannel with the nonce this
// tab stored before opening, and closes itself. This tab accepts only that
// channel's messages with the exact shape and its own pending nonce.

export interface OAuthResult {
  connected: boolean;
  connectorId: string | null;
  reason: string | null;
}

export const OAUTH_CHANNEL = "kewy-connector-oauth";
export const OAUTH_PENDING_KEY = "kewy.connector.oauth.pending";
const PENDING_MAX_MS = 15 * 60_000;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Mirrors backend CONNECTOR_OAUTH_REASONS. */
export const OAUTH_REASONS = ["invalid_state", "cancelled", "forbidden", "exchange_failed"] as const;

export interface PendingOAuth {
  nonce: string;
  /** popup: the result arrives over the channel; redirect: this tab returns itself. */
  mode: "popup" | "redirect";
  at: number;
}

export function newOAuthNonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

type KV = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const store = (): KV | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

export function savePending(p: PendingOAuth, kv: KV | null = store()): void {
  try {
    kv?.setItem(OAUTH_PENDING_KEY, JSON.stringify(p));
  } catch {
    // Storage blocked: the full-page result still works, the popup relay does not.
  }
}

export function readPending(now: number = Date.now(), kv: KV | null = store()): PendingOAuth | null {
  try {
    const v = JSON.parse(kv?.getItem(OAUTH_PENDING_KEY) ?? "null") as Partial<PendingOAuth> | null;
    if (!v || typeof v.nonce !== "string" || !/^[0-9a-f]{32}$/.test(v.nonce)) return null;
    if (v.mode !== "popup" && v.mode !== "redirect") return null;
    if (typeof v.at !== "number" || now - v.at > PENDING_MAX_MS || v.at > now + 60_000) return null;
    return { nonce: v.nonce, mode: v.mode, at: v.at };
  } catch {
    return null;
  }
}

export function clearPending(kv: KV | null = store()): void {
  try {
    kv?.removeItem(OAUTH_PENDING_KEY);
  } catch {
    // ignore
  }
}

function cleanResult(connected: boolean, connectorId: unknown, reason: unknown): OAuthResult {
  return {
    connected,
    connectorId: typeof connectorId === "string" && ID_RE.test(connectorId) ? connectorId : null,
    reason: connected ? null : typeof reason === "string" && OAUTH_REASONS.includes(reason as never) ? reason : "exchange_failed",
  };
}

/** What the relay page broadcasts. */
export function oauthBroadcast(r: OAuthResult, nonce: string) {
  return { type: "kewy-connector-oauth", connected: r.connected, connectorId: r.connectorId, reason: r.reason, nonce };
}

/**
 * Accepts a channel message only with the exact shape and this tab's
 * pending nonce (a stale, foreign or replayed message is ignored).
 */
export function acceptOAuthBroadcast(data: unknown, expectedNonce: string | null): OAuthResult | null {
  if (!expectedNonce) return null;
  const d = data as Record<string, unknown> | null;
  if (!d || typeof d !== "object" || Array.isArray(d) || d.type !== "kewy-connector-oauth" || typeof d.connected !== "boolean") return null;
  if (d.nonce !== expectedNonce) return null;
  return cleanResult(d.connected, d.connectorId, d.reason);
}

export function oauthReasonText(reason: string | null, tx: Tx): string {
  switch (reason) {
    case "invalid_state":
      return tx("The sign-in link expired or was already used. Try connecting again.", "انتهت صلاحية رابط الدخول أو استُخدم من قبل. حاول الربط مرة أخرى.");
    case "cancelled":
      return tx("Connecting was cancelled.", "أُلغي الربط.");
    case "forbidden":
      return tx("You no longer have permission to connect apps.", "لم تعد لديك صلاحية ربط التطبيقات.");
    case "exchange_failed":
      return tx("The provider did not complete the connection. Try again.", "لم يُكمل المزوّد الربط. حاول مرة أخرى.");
    default:
      return tx("Connected.", "تم الربط.");
  }
}

/**
 * Reads `connected=0|1&reason=&connector=` from the hash (the redirect
 * return). The connector id uses the same strict pattern as the channel
 * (review M1); a "connected" claim is only a hint until the refetched list
 * confirms it (`confirmedConnected`).
 */
export function oauthResultFromHash(hash: string): OAuthResult | null {
  const q = new URLSearchParams(hash.split("?")[1] ?? "");
  const c = q.get("connected");
  if (c !== "0" && c !== "1") return null;
  return cleanResult(c === "1", q.get("connector"), q.get("reason"));
}

/** Review M1: "Connected" only when the server's list shows that connector active. */
export function confirmedConnected(r: OAuthResult, cards: { connectors: { id: string; status: string }[] }[]): boolean {
  if (!r.connected || !r.connectorId) return false;
  return cards.some((c) => c.connectors.some((x) => x.id === r.connectorId && x.status === "active"));
}

/**
 * Review M3: the authorize URL must be https; a loopback http URL (local
 * vendor stubs) only in a dev build.
 */
export function allowAuthorizeUrl(raw: string, dev: boolean): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol === "https:") return !u.username && !u.password;
  return dev && u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
}

/** Latin digits in both languages. */
export const num = (n: number) => new Intl.NumberFormat("en-US").format(n);
