import type { BadgeKind } from "@/components/Badge";
import type { Tx } from "@/lib/tx";
import type { KnowledgeSource, PageState } from "@/lib/types";

/**
 * SP-21 source badges. One badge per source, by priority:
 * syncing > queued > failed > paused > pending (publishing) > partial (a
 * website with pages that need login, are blocked or errored) > synced.
 */
export type SourceBadge = "syncing" | "queued" | "failed" | "paused" | "pending" | "partial" | "synced";

const PROBLEM_STATES: PageState[] = ["needs_login", "blocked", "error"];

export function problemPages(s: Pick<KnowledgeSource, "pageCounts">): number {
  return PROBLEM_STATES.reduce((n, st) => n + (s.pageCounts?.[st] ?? 0), 0);
}

export function sourceBadge(s: Pick<KnowledgeSource, "kind" | "status" | "publishState" | "pageCounts">): SourceBadge {
  if (s.status === "processing") return "syncing";
  if (s.status === "queued" || s.status === "draft") return "queued";
  if (s.status === "failed") return "failed";
  if (s.status === "paused") return "paused";
  if (s.publishState === "pending") return "pending";
  if (s.kind === "website" && problemPages(s) > 0) return "partial";
  return "synced";
}

export const BADGE_KIND: Record<SourceBadge, BadgeKind> = {
  syncing: "info",
  queued: "info",
  failed: "bad",
  paused: "",
  pending: "info",
  partial: "warn",
  synced: "ok",
};

export function badgeText(b: SourceBadge, tx: Tx): string {
  switch (b) {
    case "syncing":
      return tx("Processing", "قيد المعالجة");
    case "queued":
      return tx("Queued", "في الانتظار");
    case "failed":
      return tx("Failed", "فشل");
    case "paused":
      return tx("Paused", "متوقف");
    case "pending":
      return tx("Publishing", "جارٍ النشر");
    case "partial":
      return tx("Some pages need attention", "بعض الصفحات تحتاج إلى انتباه");
    default:
      return tx("Ready", "جاهز");
  }
}

/** Website page states (no blocked reason is stored: a generic "Blocked"). */
export function pageStateText(state: PageState, tx: Tx): string {
  switch (state) {
    case "synced":
      return tx("Synced", "متزامنة");
    case "needs_login":
      return tx("Needs login", "تتطلب تسجيل دخول");
    case "blocked":
      return tx("Blocked", "محظورة");
    case "removed":
      return tx("Removed", "محذوفة");
    case "error":
      return tx("Error", "خطأ");
    default:
      return tx("Over the limit", "تجاوزت الحد");
  }
}

export const PAGE_STATE_KIND: Record<PageState, BadgeKind> = {
  synced: "ok",
  needs_login: "warn",
  blocked: "warn",
  removed: "",
  error: "bad",
  capped: "",
};

/** Whether the list should poll (a file processing or a website waiting to sync). */
export function shouldPoll(sources: Pick<KnowledgeSource, "status">[]): boolean {
  return sources.some((s) => s.status === "queued" || s.status === "processing");
}

/**
 * The retry note of a file or typed doc: `consecutiveFailures` there counts
 * transient retries used (never "failed N times in a row", which is the
 * website meaning).
 */
export function retryNote(s: Pick<KnowledgeSource, "kind" | "status" | "consecutiveFailures">, tx: Tx): string | null {
  if (s.kind === "website") {
    if (s.consecutiveFailures <= 0) return null;
    return tx(`Failed ${s.consecutiveFailures} time${s.consecutiveFailures === 1 ? "" : "s"} in a row`, `فشلت ${s.consecutiveFailures} مرة على التوالي`);
  }
  if ((s.kind === "file" || s.kind === "typed_doc") && s.status === "queued" && s.consecutiveFailures > 0) {
    return tx("Retrying after a temporary problem", "تتم إعادة المحاولة بعد مشكلة مؤقتة");
  }
  return null;
}

const LOCALE = (lang: "en" | "ar") => (lang === "ar" ? "ar-SA-u-nu-latn-ca-gregory" : "en-US");

/** Date and time with Latin digits, in the workspace timezone when given. */
export function formatWhen(iso: string | null | undefined, lang: "en" | "ar", timeZone?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  try {
    return new Intl.DateTimeFormat(LOCALE(lang), { dateStyle: "medium", timeStyle: "short", ...(timeZone ? { timeZone } : {}) }).format(d);
  } catch {
    return new Intl.DateTimeFormat(LOCALE(lang), { dateStyle: "medium", timeStyle: "short" }).format(d);
  }
}

/** File size for display (Latin digits). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
