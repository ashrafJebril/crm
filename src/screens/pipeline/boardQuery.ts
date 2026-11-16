import { decodeJson, encodeJson } from "@/lib/hashState";
import type { Tx } from "@/lib/tx";
import { NO_PERMISSION_AR, NO_PERMISSION_EN } from "@/auth/usePermissions";
import { safeTz } from "@/screens/followups/followupsLogic";
import type { TicketCategory, TicketPriority } from "@/lib/types";
import { TICKET_CATEGORIES, TICKET_PRIORITIES } from "./ticketFields";

export type DatePreset = "today" | "7d" | "30d" | "month" | "custom";
export type TicketStatus = "open" | "won" | "lost";
export type SortKey = "createdAt" | "updatedAt" | "value" | "enteredStageAt" | "slaDueAt" | "priority";
/** SP-09: GET /tickets?sla=… */
export type SlaFilter = "overdue" | "due_soon" | "none";
export interface Sort {
  key: SortKey;
  dir: "asc" | "desc";
}

export interface BoardFilters {
  q: string;
  preset: DatePreset | null;
  /** Custom range, YYYY-MM-DD workspace-local days (used when preset is "custom"). */
  from: string;
  to: string;
  contactId: string;
  /** Display name for the chosen customer (not sent to the server). */
  contactName: string;
  /** A user id or "none" (unassigned); "" = anyone. */
  ownerId: string;
  status: TicketStatus | "";
  /** SP-09: any of these priorities; [] = any. */
  priority: TicketPriority[];
  /** SP-09: any of these categories; [] = any. */
  category: TicketCategory[];
  /** SP-09: SLA state; "" = any. */
  sla: SlaFilter | "";
}

export const EMPTY_BOARD_FILTERS: BoardFilters = {
  q: "",
  preset: null,
  from: "",
  to: "",
  contactId: "",
  contactName: "",
  ownerId: "",
  status: "",
  priority: [],
  category: [],
  sla: "",
};

export const DEFAULT_SORT: Sort = { key: "updatedAt", dir: "desc" };
export const SORT_KEYS: SortKey[] = ["createdAt", "updatedAt", "value", "enteredStageAt", "slaDueAt", "priority"];
export const SLA_FILTERS: SlaFilter[] = ["overdue", "due_soon", "none"];

/** `v` narrowed to `allowed`, deduplicated, in `allowed` order (the backend's parseCsvList). */
function pickList<T extends string>(v: unknown, allowed: readonly T[]): T[] {
  if (!Array.isArray(v)) return [];
  return allowed.filter((a) => v.includes(a));
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** The workspace-local calendar day of `now` as [y, m, d]. */
export function localDay(now: Date, tz: string): [number, number, number] {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: safeTz(tz),
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return [get("year"), get("month"), get("day")];
}

/** Inclusive local-day range for a preset, or null for "custom". */
export function presetRange(preset: DatePreset, now: Date, tz: string): { from: string; to: string } | null {
  if (preset === "custom") return null;
  const [y, m, d] = localDay(now, tz);
  const shift = (days: number) => {
    const t = new Date(Date.UTC(y, m - 1, d + days));
    return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  };
  const today = ymd(y, m, d);
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "7d":
      return { from: shift(-6), to: today };
    case "30d":
      return { from: shift(-29), to: today };
    case "month": {
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      return { from: ymd(y, m, 1), to: ymd(y, m, last) };
    }
  }
}

/** Query string (no leading "?") for GET /tickets. Pass a sort for the table view. */
export function toQuery(
  f: BoardFilters,
  sort: Sort | null,
  ctx: { now: Date; tz: string },
): string {
  const p = new URLSearchParams();
  const q = f.q.trim();
  if (q) p.set("q", q);
  if (f.status) p.set("status", f.status);
  if (f.ownerId) p.set("ownerId", f.ownerId);
  if (f.contactId) p.set("contactId", f.contactId);
  let from = "";
  let to = "";
  if (f.preset && f.preset !== "custom") {
    const r = presetRange(f.preset, ctx.now, ctx.tz);
    from = r?.from ?? "";
    to = r?.to ?? "";
  } else if (f.preset === "custom") {
    from = DAY_RE.test(f.from) ? f.from : "";
    to = DAY_RE.test(f.to) ? f.to : "";
  }
  if (from) p.set("from", from);
  if (to) p.set("to", to);
  const priority = pickList(f.priority, TICKET_PRIORITIES);
  if (priority.length) p.set("priority", priority.join(","));
  const category = pickList(f.category, TICKET_CATEGORIES);
  if (category.length) p.set("category", category.join(","));
  if (f.sla && SLA_FILTERS.includes(f.sla)) p.set("sla", f.sla);
  if (sort) {
    p.set("view", "table");
    p.set("sort", sort.key);
    p.set("dir", sort.dir);
  }
  return p.toString();
}

/** Header click: same key flips direction, a new key starts descending. */
export function nextSort(cur: Sort, key: SortKey): Sort {
  return cur.key === key ? { key, dir: cur.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" };
}

export function filtersActive(f: BoardFilters): boolean {
  return !!(
    f.q.trim() ||
    f.preset ||
    f.contactId ||
    f.ownerId ||
    f.status ||
    f.priority.length ||
    f.category.length ||
    f.sla
  );
}

export const encodeBoardFilters = (f: unknown): string => encodeJson(f);

const PRESETS: DatePreset[] = ["today", "7d", "30d", "month", "custom"];
const STATUSES: TicketStatus[] = ["open", "won", "lost"];
const s = (v: unknown): string => (typeof v === "string" ? v : "");

/** Defensive inverse of encodeBoardFilters; anything malformed yields the empty filter. */
export function decodeBoardFilters(raw: string | null | undefined): BoardFilters {
  const o = decodeJson(raw) as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || Array.isArray(o)) return EMPTY_BOARD_FILTERS;
  return {
    q: s(o.q),
    preset: PRESETS.includes(o.preset as DatePreset) ? (o.preset as DatePreset) : null,
    from: DAY_RE.test(s(o.from)) ? s(o.from) : "",
    to: DAY_RE.test(s(o.to)) ? s(o.to) : "",
    contactId: s(o.contactId),
    contactName: s(o.contactName),
    ownerId: s(o.ownerId),
    status: STATUSES.includes(o.status as TicketStatus) ? (o.status as TicketStatus) : "",
    priority: pickList(o.priority, TICKET_PRIORITIES),
    category: pickList(o.category, TICKET_CATEGORIES),
    sla: SLA_FILTERS.includes(o.sla as SlaFilter) ? (o.sla as SlaFilter) : "",
  };
}

/** "3 updated · 2 skipped" for a bulk result. */
export function bulkResultText(tx: Tx, r: { affected: number; skipped: string[] }): string {
  const n = r.affected;
  const m = r.skipped.length;
  const a = tx(`${n} updated`, `تم تحديث ${n}`);
  return m > 0 ? `${a} · ${tx(`${m} skipped`, `تم تخطي ${m}`)}` : a;
}

/** User-facing text for the lead/reopen/bulk error keys (real Arabic). */
export function ticketActionError(tx: Tx, msg: string): string {
  if (msg.includes("Missing permission")) return tx(NO_PERMISSION_EN, NO_PERMISSION_AR);
  if (msg.includes("tickets.lead_exists"))
    return tx("This contact already has an open lead card in this pipeline.", "لدى جهة الاتصال هذه بطاقة عميل محتمل مفتوحة في هذا المسار.");
  if (msg.includes("tickets.not_closed")) return tx("This card is not closed.", "هذه البطاقة غير مغلقة.");
  if (msg.includes("pipelines.archived"))
    return tx("This pipeline is archived, so the card can't be changed.", "هذا المسار مؤرشف، لذا لا يمكن تعديل البطاقة.");
  if (msg.includes("pipelines.invalid_lost_reason"))
    return tx("That lost reason isn't available for this pipeline.", "سبب الخسارة هذا غير متاح لهذا المسار.");
  return msg || tx("Something went wrong", "حدث خطأ ما");
}

/**
 * Final review I1: the SLA filter and the SLA sort exist only on support
 * pipelines. Elsewhere a remembered `sla` (from the hash, or a pipeline
 * switch) is dropped and an `slaDueAt` sort falls back to the default, so the
 * board never filters by something it does not show. Support is unchanged.
 */
export function scopeToPipeline(
  filters: BoardFilters,
  sort: Sort,
  kind: string | null | undefined,
): { filters: BoardFilters; sort: Sort } {
  if (kind === "support") return { filters, sort };
  return {
    filters: filters.sla ? { ...filters, sla: "" } : filters,
    sort: sort.key === "slaDueAt" ? DEFAULT_SORT : sort,
  };
}
