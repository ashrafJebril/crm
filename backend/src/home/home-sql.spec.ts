import type { Prisma } from "@prisma/client";
import * as sql from "./home-sql";
import { openableSql } from "./home-records";

/** Structural checks on the home's statements (the DB spec runs them). */
const days = {
  todayStart: new Date("2026-11-09T21:00:00Z"),
  tomorrowStart: new Date("2026-11-10T21:00:00Z"),
  tomorrowEnd: new Date("2026-11-11T21:00:00Z"),
};
const now = new Date("2026-11-10T09:00:00Z");
const scope = { assigneeId: "u1" };

const statements: [string, Prisma.Sql][] = [
  ["waitingConversations", sql.waitingConversationsSql("ws1", "u1", scope)],
  ["lateFollowUps", sql.lateFollowUpsSql("ws1", "u1", days, true, true)],
  ["unassignedTickets", sql.unassignedTicketsSql("ws1", true)],
  ["unassignedTickets", sql.unassignedTicketsSql("ws1", false)],
  ["dayFollowUps", sql.dayFollowUpsSql("ws1", "u1", days, false, true)],
  ["dayBookings", sql.dayBookingsSql("ws1", "u1", days, true)],
  ["dayBookings", sql.dayBookingsSql("ws1", "u1", days, false)],
  ["dayTicketsDue", sql.dayTicketsDueSql("ws1", "u1", days)],
  ["away", sql.awaySql("ws1", new Date("2026-11-09T09:00:00Z"), now, scope, { conversations: true, bookings: true, tickets: true })],
  ["away", sql.awaySql("ws1", new Date("2026-11-09T09:00:00Z"), now, scope, { conversations: false, bookings: false, tickets: false })],
  ["day1", sql.day1Sql("ws1", true)],
  ["day1", sql.day1Sql("ws1", false)],
  ["day1", sql.day1Sql("ws1", true, true)],
  ["openable", openableSql("ws1", scope, { conversation: true, ticket: true, booking: true }, { conversation: ["c1"], ticket: ["t1"], booking: ["b1"] }) as Prisma.Sql],
];

describe("home SQL builders", () => {
  it.each(statements.map(([tag, s], i) => [`${tag} #${i}`, tag, s] as const))("%s is tagged, balanced and workspace-bound", (_n, tag, s) => {
    expect(s.strings[0]).toContain(`/* home:${tag} */`);
    let depth = 0;
    for (const ch of s.strings.join("?")) {
      if (ch === "(") depth += 1;
      if (ch === ")") depth -= 1;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
    // (Away with no permitted kind reads no table at all.)
    if (s.values.length > 0) expect(s.values).toContain("ws1");
    expect(s.strings.join("?")).not.toContain("undefined");
  });

  it("the follow-up link gate follows SP-04", () => {
    const t = (a: boolean, b: boolean) => sql.followUpLinkSql(a, b).strings.join("");
    expect(t(true, true)).toBe("");
    expect(t(true, false)).toContain('"ticketId" IS NOT NULL');
    expect(t(false, true)).toContain('"ticketId" IS NULL');
    expect(t(false, false)).toContain("FALSE");
  });

  it("the re-check asks only for kinds the member may view, scope on conversations", () => {
    const s = openableSql("ws1", scope, { conversation: true, ticket: false, booking: true }, { conversation: ["c1"], ticket: ["t1"], booking: [] })!;
    const text = s.strings.join("?");
    expect(text).toContain('"Conversation"');
    expect(text).not.toContain('"Ticket"');
    expect(text).not.toContain('"Appointment"');
    expect(text).toContain('AND c."assigneeId" = ?');
    expect(openableSql("ws1", scope, { conversation: false, ticket: false, booking: false }, { conversation: ["c1"], ticket: [], booking: [] })).toBeNull();
  });
});
