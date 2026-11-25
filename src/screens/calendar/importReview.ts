/**
 * SP-10 catalog import wizard model (pure): the wizard step for a job, the
 * poll cadence, the review table's grouping and counts, client-side checks
 * that mirror the backend's `catalog_import.item_invalid` fields, and the
 * PATCH body for review edits.
 */
import type { CatalogImport, ProposalItem, ProposalServiceData, ProposalStaffData, WeeklySchedule } from "@/lib/types";
import { CURRENCY_PATTERN, PRICE_PATTERN, SERVICE_DURATION_MAX, SERVICE_DURATION_MIN } from "./bookingConstants";
import { validateSchedule } from "./schedule";

export type WizardStep = "source" | "extracting" | "review" | "running" | "result";

/** The wizard step a job is at (no job yet: the source step). */
export function stepFor(job: CatalogImport | null): WizardStep {
  if (!job) return "source";
  switch (job.status) {
    case "extracting":
      return "extracting";
    case "review":
      return "review";
    case "running":
      return "running";
    default:
      return "result";
  }
}

/** Poll while the server works (extracting, running); stop otherwise. */
export function pollMsFor(job: CatalogImport | null | undefined): number | null {
  if (!job) return null;
  if (job.status === "extracting") return 2000;
  if (job.status === "running") return 1500;
  return null;
}

/** Run progress, 0..100. */
export function progressPct(job: CatalogImport): number {
  if (job.status === "done") return 100;
  if (!job.total) return 0;
  return Math.min(100, Math.round((job.processed / job.total) * 100));
}

export interface ReviewGroups {
  services: ProposalItem[];
  staff: ProposalItem[];
}

export function groupItems(items: ProposalItem[] | undefined): ReviewGroups {
  const list = items ?? [];
  return { services: list.filter((i) => i.kind === "service"), staff: list.filter((i) => i.kind === "staff") };
}

export interface ReviewCounts {
  total: number;
  selected: number;
  duplicates: number;
  errors: number;
  /** Selected rows that still have an error: the run would be refused. */
  blocking: number;
}

export function reviewCounts(items: ProposalItem[] | undefined): ReviewCounts {
  const list = items ?? [];
  return {
    total: list.length,
    selected: list.filter((i) => i.selected).length,
    duplicates: list.filter((i) => i.duplicateOf).length,
    errors: list.filter((i) => i.error).length,
    blocking: list.filter((i) => i.selected && i.error).length,
  };
}

export const canRun = (items: ProposalItem[] | undefined) => {
  const c = reviewCounts(items);
  return c.selected > 0 && c.blocking === 0;
};

/** "Select all" for a group: rows with an error stay unchecked (they would block the run). */
export function selectAllPatch(items: ProposalItem[], on: boolean): { key: string; selected: boolean }[] {
  return items.filter((i) => (on ? !i.error && !i.selected : i.selected)).map((i) => ({ key: i.key, selected: on }));
}

export type EditField =
  | "name"
  | "nameAr"
  | "durationMin"
  | "price"
  | "currency"
  | "role"
  | "schedule"
  | "services";

/**
 * A review edit as the PATCH sends it, or the field the backend would refuse
 * (same rules: duration 5..1440, a DECIMAL(12,2) price, a 3-letter currency,
 * a valid schedule, a non-empty name).
 */
export function editPatch(
  item: ProposalItem,
  field: EditField,
  raw: string | WeeklySchedule | string[],
): { ok: true; patch: { key: string; data: Record<string, unknown> } } | { ok: false; field: EditField } {
  const bad = { ok: false as const, field };
  const done = (value: unknown) => ({ ok: true as const, patch: { key: item.key, data: { [field]: value } } });
  const text = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (item.kind === "service") {
    switch (field) {
      case "name":
      case "nameAr":
        return text && text.length <= 120 ? done(text) : bad;
      case "durationMin": {
        if (!/^\d+$/.test(text)) return bad;
        const n = Number(text);
        return n >= SERVICE_DURATION_MIN && n <= SERVICE_DURATION_MAX ? done(n) : bad;
      }
      case "price":
        if (!text) return done(null);
        return PRICE_PATTERN.test(text) ? done(text) : bad;
      case "currency": {
        if (!text) return done(null);
        const c = text.toUpperCase();
        return CURRENCY_PATTERN.test(c) ? done(c) : bad;
      }
      default:
        return bad;
    }
  }
  switch (field) {
    case "name":
      return text && text.length <= 120 ? done(text) : bad;
    case "nameAr":
      return text.length <= 120 ? done(text || null) : bad;
    case "role":
      return text.length <= 80 ? done(text || null) : bad;
    case "schedule": {
      const r = validateSchedule(raw);
      return r.ok ? done(raw) : bad;
    }
    case "services":
      return Array.isArray(raw) ? done(raw.map((s) => s.trim()).filter(Boolean)) : bad;
    default:
      return bad;
  }
}

/** The display data of an item, typed by kind. */
export const serviceDataOf = (i: ProposalItem) => i.data as ProposalServiceData;
export const staffDataOf = (i: ProposalItem) => i.data as ProposalStaffData;

/** Run errors grouped for the result step. */
export function resultSummary(job: CatalogImport): { created: number; skipped: number; failed: number; rowErrors: CatalogImport["errors"] } {
  return { created: job.created, skipped: job.skipped, failed: job.failed, rowErrors: Array.isArray(job.errors) ? job.errors : [] };
}
