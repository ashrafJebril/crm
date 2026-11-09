import type { Lang } from "@/lib/types";

export type ActivityKind = "follow_up" | "call" | "meeting" | "task" | "note_log";

export interface Activity {
  id: string;
  kind: ActivityKind;
  title: string;
  notes: string | null;
  dueAt: string | null;
  doneAt: string | null;
  outcome: string | null;
  assigneeId: string | null;
  contactId: string | null;
  ticketId: string | null;
  createdAt: string;
  contact?: { id: string; name: string } | null;
  ticket?: { id: string; number: number; title: string } | null;
}

export interface QueueResponse {
  overdue: Activity[];
  today: Activity[];
  upcoming: Activity[];
  counts: { overdue: number; today: number; upcoming: number };
  nextCursorUpcoming: string | null;
}

export type SectionKey = "overdue" | "today" | "upcoming";
export interface Section {
  key: SectionKey;
  items: Activity[];
  count: number;
}

/** Overdue, Today, Upcoming in that order; empty sections are dropped and the
 *  server's counts win over the (capped / paged) item lists. */
export function groupForDisplay(q: QueueResponse): Section[] {
  const keys: SectionKey[] = ["overdue", "today", "upcoming"];
  return keys
    .map((key) => ({ key, items: q[key], count: Math.max(q.counts[key], q[key].length) }))
    .filter((s) => s.items.length > 0);
}

// ── timezone helpers (Intl only, no dependency) ───────────────────────────

interface Parts { y: number; mo: number; d: number; h: number; mi: number }

function zonedParts(date: Date, tz: string): Parts {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
  });
  const m: Record<string, number> = {};
  for (const p of f.formatToParts(date)) if (p.type !== "literal") m[p.type] = Number(p.value);
  return { y: m.year, mo: m.month, d: m.day, h: m.hour % 24, mi: m.minute };
}

/** Wall-clock time in `tz` to a UTC instant (two-pass offset correction handles DST). */
function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(new Date(guess), tz);
    const seen = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
    guess += wall - seen;
  }
  return new Date(guess);
}

export type QuickChoice = "plus1h" | "tomorrow9" | "nextWeek";

export function quickReschedule(now: Date, choice: QuickChoice, tz: string): Date {
  if (choice === "plus1h") return new Date(now.getTime() + 3600_000);
  const p = zonedParts(now, tz);
  const add = choice === "tomorrow9" ? 1 : 7;
  const day = new Date(Date.UTC(p.y, p.mo - 1, p.d + add));
  return zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), 9, 0, tz);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** ISO instant to the value of a `datetime-local` input, in the workspace zone. */
export function toLocalInput(iso: string, tz: string): string {
  const p = zonedParts(new Date(iso), tz);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`;
}

/** `datetime-local` value interpreted in the workspace zone; null when invalid. */
export function fromLocalInput(v: string, tz: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  return zonedToUtc(y, mo, d, h, mi, tz);
}

const dayNumber = (p: Parts) => Math.round(Date.UTC(p.y, p.mo - 1, p.d) / 86400000);

export function formatDue(dueAt: string, now: Date, tz: string, lang: Lang): string {
  const due = new Date(dueAt);
  const dp = zonedParts(due, tz);
  const diff = dayNumber(dp) - dayNumber(zonedParts(now, tz));
  const time = `${pad(dp.h)}:${pad(dp.mi)}`;
  const ar = lang === "ar";
  if (diff === 0) return `${ar ? "اليوم" : "Today"} ${time}`;
  if (diff === 1) return `${ar ? "غدًا" : "Tomorrow"} ${time}`;
  if (diff === -1) return `${ar ? "أمس" : "Yesterday"} ${time}`;
  const date = new Intl.DateTimeFormat(ar ? "ar-u-nu-latn" : "en-US", {
    timeZone: tz, month: "short", day: "numeric",
  }).format(due);
  return `${date} ${time}`;
}
