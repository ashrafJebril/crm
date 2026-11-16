import { describe, expect, it } from "vitest";
import type { HomeDto, HomeSection } from "@/lib/homeTypes";
import { day1Progress, followUpHref, homeView, sectionView, showDay1, waitingSinceWords } from "./homeModel";

const ok = <T>(data: T): HomeSection<T> => ({ status: "ok", data });
const forbidden = { status: "forbidden" } as const;
const unavailable = { status: "unavailable" } as const;

function home(over: Partial<HomeDto> = {}): HomeDto {
  const day = { followUps: ok([]), bookings: ok([]), ticketsDue: ok([]) };
  return {
    now: "2026-11-10T09:00:00.000Z",
    tz: "Asia/Riyadh",
    needsPerson: {
      waitingConversations: ok({ total: 0, items: [] }),
      lateFollowUps: ok({ total: 0, items: [] }),
      unassignedTickets: ok({ total: 0, items: [] }),
    },
    today: day,
    tomorrow: day,
    away: ok({ since: "2026-11-09T09:00:00.000Z", aiReplies: 0, aiResolved: 0, agentBookings: 0, autoTickets: 0, conversations: [] }),
    day1: { show: false, steps: [] },
    ...over,
  };
}

describe("home model", () => {
  it("home sections hide forbidden parts and show unavailable ones", () => {
    expect(sectionView(ok(1))).toBe("ok");
    expect(sectionView(forbidden)).toBe("hidden");
    expect(sectionView(unavailable)).toBe("unavailable");
    expect(sectionView(undefined)).toBe("hidden");

    const v = homeView(
      home({
        needsPerson: { waitingConversations: forbidden, lateFollowUps: unavailable, unassignedTickets: ok({ total: 1, items: [] }) },
        today: { followUps: ok([]), bookings: forbidden, ticketsDue: unavailable },
        tomorrow: { followUps: ok([]), bookings: forbidden, ticketsDue: unavailable },
      }),
    );
    // Needs a person: the forbidden list is gone, the unavailable one stays (and says so).
    expect(v.needsPerson.map((p) => [p.key, p.state])).toEqual([
      ["lateFollowUps", "unavailable"],
      ["unassignedTickets", "ok"],
    ]);
    expect(v.days.map((p) => [p.key, p.state])).toEqual([
      ["followUps", "ok"],
      ["ticketsDue", "unavailable"],
    ]);
    expect(v.showNeedsPerson).toBe(true);
    expect(v.showDays).toBe(true);
    expect(v.away).toBe("ok");

    // Every part forbidden: the whole block is hidden.
    const none = homeView(
      home({
        needsPerson: { waitingConversations: forbidden, lateFollowUps: forbidden, unassignedTickets: forbidden },
        today: { followUps: forbidden, bookings: forbidden, ticketsDue: forbidden },
        tomorrow: { followUps: forbidden, bookings: forbidden, ticketsDue: forbidden },
        away: forbidden,
      }),
    );
    expect(none.showNeedsPerson).toBe(false);
    expect(none.showDays).toBe(false);
    expect(none.away).toBe("hidden");
  });

  it("day-1 progress counts done steps", () => {
    const steps = [
      { key: "connect_channel", done: true, href: "#/channels" },
      { key: "add_knowledge", done: false, href: "#/settings?tab=aiKnowledge" },
      { key: "invite_team", done: true, href: "#/settings?tab=members" },
      { key: "first_reply", done: false, href: "#/inbox" },
    ] as const;
    expect(day1Progress([...steps])).toEqual({ done: 2, total: 4, pct: 50 });
    expect(day1Progress([])).toEqual({ done: 0, total: 0, pct: 0 });
    expect(day1Progress([{ key: "first_reply", done: true, href: "#/inbox" }])).toEqual({ done: 1, total: 1, pct: 100 });
    expect(showDay1(home({ day1: { show: true, steps: [...steps] } }))).toBe(true);
    expect(showDay1(home({ day1: { show: false, steps: [...steps] } }))).toBe(false);
    expect(showDay1(null)).toBe(false);
  });

  it("waiting-since words use Latin digits in both languages", () => {
    const now = new Date("2026-11-10T09:00:00Z");
    expect(waitingSinceWords("2026-11-10T08:59:40Z", now, "en")).toBe("just now");
    expect(waitingSinceWords("2026-11-10T08:48:00Z", now, "en")).toBe("12 min");
    expect(waitingSinceWords("2026-11-10T06:00:00Z", now, "en")).toBe("3 h");
    expect(waitingSinceWords("2026-11-08T09:00:00Z", now, "en")).toBe("2 d");
    expect(waitingSinceWords("2026-11-10T08:59:40Z", now, "ar")).toBe("الآن");
    expect(waitingSinceWords("2026-11-10T08:48:00Z", now, "ar")).toBe("12 د");
    expect(waitingSinceWords("2026-11-10T06:00:00Z", now, "ar")).toBe("3 س");
    expect(waitingSinceWords("2026-11-08T09:00:00Z", now, "ar")).toBe("2 ي");
    expect(waitingSinceWords("not a date", now, "en")).toBe("");
  });

  it("follow-up rows open their linked record", () => {
    expect(followUpHref({ ticketId: "t1", contactId: "c1" }, "#/dashboard")).toBe("#/dashboard?record=ticket%3At1");
    expect(followUpHref({ ticketId: null, contactId: "c1" }, "#/dashboard")).toBe("#/dashboard?record=contact%3Ac1");
    expect(followUpHref({ ticketId: null, contactId: null }, "#/dashboard")).toMatch(/^#\/followups/);
  });
});
