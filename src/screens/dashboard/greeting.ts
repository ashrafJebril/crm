import type { Lang } from "@/lib/types";

/** SP-11: the dashboard greeting (pure). Workspace-local hour; the member's
 *  first name (never a hardcoded one); "Welcome back" without a name. */

const DEFAULT_TZ = "Asia/Riyadh";

function validTz(tz: string | null | undefined): string {
  if (!tz) return DEFAULT_TZ;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TZ;
  }
}

/** The local hour (0–23) of `now` in `tz`. */
export function localHour(now: Date, tz: string | null | undefined): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: validTz(tz), hour: "numeric", hourCycle: "h23" }).format(now);
  return Number(h) % 24;
}

/** The first word of a display name, or null. */
export function firstNameOf(name: string | null | undefined): string | null {
  const first = (name ?? "").trim().split(/\s+/)[0];
  return first ? first : null;
}

type Part = "morning" | "afternoon" | "evening";

/** Morning 05–12, afternoon 12–17, evening otherwise (local hours). */
export function partOfDay(now: Date, tz: string | null | undefined): Part {
  const h = localHour(now, tz);
  if (h >= 5 && h < 12) return "morning";
  if (h >= 12 && h < 17) return "afternoon";
  return "evening";
}

const COPY: Record<Part, { en: string; ar: string }> = {
  morning: { en: "Good morning", ar: "صباح الخير" },
  afternoon: { en: "Good afternoon", ar: "نهارك سعيد" },
  evening: { en: "Good evening", ar: "مساء الخير" },
};

export function greeting(now: Date, tz: string | null | undefined, firstName: string | null | undefined, lang: Lang): string {
  const name = (firstName ?? "").trim();
  if (!name) return lang === "ar" ? "أهلاً بعودتك" : "Welcome back";
  const c = COPY[partOfDay(now, tz)];
  return lang === "ar" ? `${c.ar} يا ${name}` : `${c.en}, ${name}`;
}

export function homeSubtitle(workspaceName: string | null | undefined, lang: Lang): string {
  const ws = (workspaceName ?? "").trim();
  if (lang === "ar") return ws ? `إليك ما يحدث في ${ws} اليوم` : "إليك ما يحدث في مساحة عملك اليوم";
  return ws ? `Here's how ${ws} is doing today` : "Here's how your workspace is doing today";
}
