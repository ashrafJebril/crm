import type { Day1Step, HomeDay, HomeDto, HomeSection } from "@/lib/homeTypes";
import { recordHref } from "@/lib/recordLink";
import type { Lang } from "@/lib/types";

/** SP-11 working home: pure view rules (no React). */

export type SectionState = "ok" | "unavailable" | "hidden";

/** `forbidden` (or missing) parts are hidden; `unavailable` ones stay and say so. */
export function sectionView(s: HomeSection<unknown> | undefined | null): SectionState {
  if (!s || s.status === "forbidden") return "hidden";
  return s.status === "unavailable" ? "unavailable" : "ok";
}

type NeedsKey = keyof HomeDto["needsPerson"];
type DayKey = keyof HomeDay;

export interface HomeView {
  needsPerson: { key: NeedsKey; state: Exclude<SectionState, "hidden"> }[];
  /** Day parts, judged on today (tomorrow has the same permissions). */
  days: { key: DayKey; state: Exclude<SectionState, "hidden"> }[];
  showNeedsPerson: boolean;
  showDays: boolean;
  away: SectionState;
}

const NEEDS: NeedsKey[] = ["waitingConversations", "lateFollowUps", "unassignedTickets"];
const DAY: DayKey[] = ["followUps", "bookings", "ticketsDue"];

export function homeView(h: HomeDto): HomeView {
  const needsPerson = NEEDS.map((key) => ({ key, state: sectionView(h.needsPerson[key]) }))
    .filter((x): x is { key: NeedsKey; state: "ok" | "unavailable" } => x.state !== "hidden");
  const days = DAY.map((key) => ({ key, state: sectionView(h.today[key]) }))
    .filter((x): x is { key: DayKey; state: "ok" | "unavailable" } => x.state !== "hidden");
  return {
    needsPerson,
    days,
    showNeedsPerson: needsPerson.length > 0,
    showDays: days.length > 0,
    away: sectionView(h.away),
  };
}

export function day1Progress(steps: Day1Step[]): { done: number; total: number; pct: number } {
  const done = steps.filter((s) => s.done).length;
  const total = steps.length;
  return { done, total, pct: total ? Math.round((100 * done) / total) : 0 };
}

export function showDay1(h: HomeDto | null | undefined): boolean {
  return !!h && h.day1.show && h.day1.steps.length > 0;
}

/** How long a customer has been waiting, short, Latin digits. */
export function waitingSinceWords(sinceIso: string, now: Date, lang: Lang): string {
  const t = Date.parse(sinceIso);
  if (Number.isNaN(t)) return "";
  const min = Math.max(0, Math.floor((now.getTime() - t) / 60_000));
  const ar = lang === "ar";
  if (min < 1) return ar ? "الآن" : "just now";
  if (min < 60) return ar ? `${min} د` : `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return ar ? `${h} س` : `${h} h`;
  const d = Math.floor(h / 24);
  return ar ? `${d} ي` : `${d} d`;
}

/** A follow-up opens its ticket, else its contact, else the follow-ups queue. */
export function followUpHref(f: { ticketId: string | null; contactId: string | null }, currentHash: string): string {
  if (f.ticketId) return recordHref("ticket", f.ticketId, currentHash) as string;
  if (f.contactId) return recordHref("contact", f.contactId, currentHash) as string;
  return "#/followups";
}
