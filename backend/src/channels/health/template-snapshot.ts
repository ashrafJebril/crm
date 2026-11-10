import { asChannelHealth, UNKNOWN, type SignalError, type TemplateItem } from "./health-model";

/** Base language: "en_US" → "en" (as `TemplatesService.key` matches). */
export const baseLanguage = (l: string | null | undefined) => String(l ?? "").split(/[_-]/)[0].toLowerCase();

/** One number's template snapshot (`GET /channels/:id/templates`), read from its stored health. */
export interface NumberTemplates {
  channelId: string;
  /** When the snapshot's template list was read; null when never read. */
  checkedAt: string | null;
  /** Why the list is unknown (e.g. `check_failed`); null when known or never checked. */
  error: SignalError;
  truncated: boolean;
  /** False when there is no snapshot or its template list is unknown (then `items` is empty). */
  known: boolean;
  items: TemplateItem[];
}

/** The template snapshot of a stored `Channel.health` (no provider call). */
export function snapshotTemplates(channelId: string, health: unknown): NumberTemplates {
  const h = asChannelHealth(health);
  const t = h?.templates;
  if (!t || t.value === UNKNOWN || !t.value || typeof t.value !== "object") {
    return { channelId, checkedAt: t?.checkedAt ?? null, error: t?.error ?? null, truncated: false, known: false, items: [] };
  }
  return {
    channelId,
    checkedAt: t.checkedAt ?? null,
    error: null,
    truncated: !!t.value.truncated,
    known: true,
    items: Array.isArray(t.value.items) ? t.value.items : [],
  };
}

/**
 * The copy of a template (name + base language) in a snapshot: the exact
 * language first, then an APPROVED one, then any.
 */
export function findTemplateCopy(items: readonly TemplateItem[], name: string, lang: string): TemplateItem | null {
  const hits = items.filter((t) => t.name === name && baseLanguage(t.language) === baseLanguage(lang));
  return hits.find((t) => t.language === lang) ?? hits.find((t) => t.status === "APPROVED") ?? hits[0] ?? null;
}
