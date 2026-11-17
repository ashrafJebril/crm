import { API_BASE } from "@/api/client";
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

export interface OAuthResult {
  connected: boolean;
  connectorId: string | null;
  reason: string | null;
}

/** The backend's origin (the OAuth callback page is served from it). */
export function backendOrigin(base: string = API_BASE): string {
  try {
    return new URL(base, typeof window === "undefined" ? "http://localhost" : window.location.href).origin;
  } catch {
    return "";
  }
}

/**
 * Accepts the callback page's message only from the backend origin and only
 * with the exact expected shape; anything else (another origin, another
 * window's message, a malformed object) is ignored.
 */
export function acceptOAuthMessage(event: { origin: string; data: unknown }, expectedOrigin: string): OAuthResult | null {
  if (!expectedOrigin || event.origin !== expectedOrigin) return null;
  const d = event.data as Record<string, unknown> | null;
  if (!d || typeof d !== "object" || d.type !== "kewy-connector-oauth" || typeof d.connected !== "boolean") return null;
  const connectorId = typeof d.connectorId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(d.connectorId) ? d.connectorId : null;
  const reason = typeof d.reason === "string" && OAUTH_REASONS.includes(d.reason as never) ? d.reason : d.connected ? null : "exchange_failed";
  return { connected: d.connected, connectorId, reason: d.connected ? null : reason };
}

/** Mirrors backend CONNECTOR_OAUTH_REASONS. */
export const OAUTH_REASONS = ["invalid_state", "cancelled", "forbidden", "exchange_failed"] as const;

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

/** Reads `connected=0|1&reason=&connector=` from the hash (the full-page fallback). */
export function oauthResultFromHash(hash: string): OAuthResult | null {
  const q = new URLSearchParams(hash.split("?")[1] ?? "");
  const c = q.get("connected");
  if (c !== "0" && c !== "1") return null;
  const reason = q.get("reason");
  return {
    connected: c === "1",
    connectorId: q.get("connector"),
    reason: c === "1" ? null : reason && OAUTH_REASONS.includes(reason as never) ? reason : "exchange_failed",
  };
}

/** Latin digits in both languages. */
export const num = (n: number) => new Intl.NumberFormat("en-US").format(n);
