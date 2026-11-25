/**
 * Hand-written expected values for the SP-11 fixture world
 * (`__fixtures__/insights-world.ts`), range 2026-11-01 … 2026-11-07 in
 * Asia/Riyadh = [2026-10-31T21:00Z, 2026-11-07T21:00Z). Worked by hand from
 * the plan's metric definitions; the reasoning is next to each value. Both
 * the TS oracle and the real SQL must produce exactly these.
 */
import { CH, ST, U } from "./__fixtures__/insights-world";
import type { ByNumberRow, Peaks, ResolutionMix, SupportHeadline, TeamRow, TopicFrictionRow } from "./insights.dto";
import { emptyPeaks, type FunnelRow, type LostReasonRow, type RepRow, type SourceRow } from "./insights-format";

export interface SupportExpectation {
  headline: SupportHeadline;
  resolutionMix: ResolutionMix;
  peaks: Peaks;
  byNumber: ByNumberRow[];
  topicFriction: TopicFrictionRow[];
  team: TeamRow[];
}

function peaks(cells: [dow: number, hour: number][]): Peaks {
  const p = emptyPeaks();
  for (const [d, h] of cells) {
    p.matrix[d][h] += 1;
    p.byHour[h] += 1;
  }
  return p;
}

const member = (userId: string, name: string, over: Partial<TeamRow> = {}): TeamRow => ({
  userId,
  name,
  former: false,
  assigned: 0,
  replies: 0,
  medianFirstResponseSec: null,
  resolved: 0,
  ...over,
});

/**
 * The owner (visibility "all"), no channel filter.
 *
 * Range conversations (a customer message in range): cv1, cv2, cv3, cv4,
 * cv5 (21:05Z is in range though its exchange began at 20:50Z), cv6, cv7,
 * cv10 (20:59Z) = 8. Not cv8/cv9/cv12 (older), not cv11 (21:00Z = the
 * exclusive end).
 *
 * Decided (resolvedAt in range, resolved/closed): cv1, cv2, cv3, cv5, cv6,
 * cv8, cv9 = 7 (cv12 resolved at 20:59Z, before the range; cv7 is open).
 * Buckets, first match wins: cv3 closed; cv5 (issue escalation) and cv6
 * (escalated, complaint) escalated; cv2 human (staff 08:12 within 7 days;
 * its NULL issue is not a complaint); cv1, cv8 ai (no staff at all); cv9 ai
 * (its staff reply is 13 days before resolvedAt, outside the lookback).
 */
export const OWNER: SupportExpectation = {
  headline: {
    conversations: 8,
    decided: 7,
    aiResolved: 3,
    aiResolutionRate: 42.9, // 3 / 7
    // Exchanges in range: cv1 AI-only (excluded); cv2 AI then staff after
    // 12 min → 720; cv3 staff in 3 min → 180; cv4 no reply (unanswered);
    // cv6 staff (former member) after 20 min → 1200; cv7 legacy staff after
    // 2 min → 120, then an AI-only exchange (excluded); cv10 AI-only
    // (excluded); cv5's exchange began before `from` (excluded).
    // Median of 120, 180, 720, 1200 = (180 + 720) / 2 = 450 s = 7.5 min.
    medianFirstResponseSec: 450,
    unanswered: 1,
    // cv1 7200, cv2 3600, cv3 48600 (20:30Z → 10:00Z next day), cv5 33000
    // (20:50Z → 06:00Z), cv6 3600, cv8 172800 (two days back, inside the
    // lookback); cv9 has no exchange in the lookback (excluded).
    // Median of 3600, 3600, 7200, 33000, 48600, 172800 = (7200 + 33000) / 2.
    medianHandlingSec: 20100,
    // Answered first by the AI: cv1 10:00, cv2 08:00, cv7 06:00, cv10 20:59
    // (its AI reply lands after the range; the message is in range) = 4.
    // 4 × 60 s = 240 s = 0.07 h → 0.1.
    timeSaved: { customerMessages: 4, hours: 0.1 },
    // cv3 (tk3) and cv6 (tk1, tk2 count once) of 8; cv7's support ticket is
    // older and its leads ticket is not support; cv8 is not a range conversation.
    ticketShare: 25,
  },
  resolutionMix: { ai: 3, human: 1, escalated: 2, closed: 1 },
  // Riyadh = UTC+3. Sun 1 Nov 00:05 (cv5); Mon 2 Nov 08:00, 09:00 (cv7), 13:00
  // (cv1); Tue 11:00 (cv2); Wed 23:30 (cv3, 20:30Z); Fri 6 Nov 00:30 (cv4,
  // 21:30Z on Thu 5th), 12:00 (cv6); Sat 23:59 (cv10).
  peaks: peaks([
    [0, 0],
    [1, 8],
    [1, 9],
    [1, 13],
    [2, 11],
    [3, 23],
    [5, 0],
    [5, 12],
    [6, 23],
  ]),
  // WhatsApp only (cv6 is Instagram). Riyadh line: cv1, cv2, cv5, cv7; decided
  // cv1 ai, cv2 human, cv5 escalated, cv8 ai, cv9 ai → 3/5. Jeddah line: cv3,
  // cv4; decided cv3 closed → 0/1 (a real 0, not null). No channel: cv10;
  // nothing decided → null.
  byNumber: [
    { channelId: CH.a, label: "Riyadh line", conversations: 4, aiResolutionRate: 60 },
    { channelId: CH.b, label: "Jeddah line", conversations: 2, aiResolutionRate: 0 },
    { channelId: null, label: "Unassigned number", conversations: 1, aiResolutionRate: null },
  ],
  // delivery: cv1, cv2 (three spellings, once), cv5, cv6, cv8, cv9 = 6;
  // escalated cv5, cv6 = 2/6; negative cv5, cv6 = 2/6. refund: cv2, cv3,
  // cv5, cv6 = 4; escalated cv5, cv6 = 2/4; negative cv3, cv5, cv6 = 3/4.
  // pricing: cv1, cv2 = 2 (< 3, dropped).
  topicFriction: [
    { topic: "delivery", count: 6, escalatedShare: 33.3, negativeShare: 33.3 },
    { topic: "refund", count: 4, escalatedShare: 50, negativeShare: 75 },
  ],
  // assigned (range conversations): Badr cv1, cv2, cv6; Sami cv3, cv5; Omar
  // cv7; former cv4. replies (staff messages in range): Badr cv2; Sami cv3,
  // cv5 (21:20Z); former cv6; unattributed cv7. First response: as above,
  // grouped by the replying sender. resolved (human bucket): Badr cv2.
  team: [
    member(U.assigned, "Sami", { assigned: 2, replies: 2, medianFirstResponseSec: 180 }),
    member(U.agent, "Badr", { assigned: 3, replies: 1, medianFirstResponseSec: 720, resolved: 1 }),
    member(U.owner, "Omar", { assigned: 1 }),
    member(U.admin, "Amal"),
    member(U.viewer, "Huda"),
    { userId: null, name: "Former member", former: true, assigned: 1, replies: 1, medianFirstResponseSec: 1200, resolved: 0 },
    { userId: null, name: "Unattributed", former: false, assigned: 0, replies: 1, medianFirstResponseSec: 120, resolved: 0 },
  ],
};

/**
 * The assigned-only agent Sami: only cv3, cv5 and cv9 exist for him.
 * Range conversations cv3, cv5 = 2. Decided cv3 closed, cv5 escalated,
 * cv9 ai = 3.
 */
export const ASSIGNED: SupportExpectation = {
  headline: {
    conversations: 2,
    decided: 3,
    aiResolved: 1,
    aiResolutionRate: 33.3, // 1 / 3
    medianFirstResponseSec: 180, // cv3 only
    unanswered: 0,
    medianHandlingSec: 40800, // (33000 + 48600) / 2
    timeSaved: { customerMessages: 0, hours: 0 },
    ticketShare: 50, // cv3 of 2
  },
  resolutionMix: { ai: 1, human: 0, escalated: 1, closed: 1 },
  peaks: peaks([
    [0, 0], // cv5 21:05Z
    [3, 23], // cv3 20:30Z
  ]),
  // Both numbers have one conversation: by label.
  byNumber: [
    { channelId: CH.b, label: "Jeddah line", conversations: 1, aiResolutionRate: 0 }, // cv3 closed
    { channelId: CH.a, label: "Riyadh line", conversations: 1, aiResolutionRate: 50 }, // cv5 escalated, cv9 ai
  ],
  topicFriction: [], // refund 2, delivery 2: under 3
  team: [
    member(U.assigned, "Sami", { assigned: 2, replies: 2, medianFirstResponseSec: 180 }),
    member(U.admin, "Amal"),
    member(U.agent, "Badr"),
    member(U.viewer, "Huda"),
    member(U.owner, "Omar"),
  ],
};

/** The owner, filtered to the Jeddah line (cv3, cv4). */
export const OWNER_JEDDAH_HEADLINE: SupportHeadline = {
  conversations: 2,
  decided: 1,
  aiResolved: 0,
  aiResolutionRate: 0,
  medianFirstResponseSec: 180,
  unanswered: 1,
  medianHandlingSec: 48600,
  timeSaved: { customerMessages: 0, hours: 0 },
  ticketShare: 50,
};

/** An empty workspace: every rate and median null, every count 0. */
export const EMPTY: SupportExpectation = {
  headline: {
    conversations: 0,
    decided: 0,
    aiResolved: 0,
    aiResolutionRate: null,
    medianFirstResponseSec: null,
    unanswered: 0,
    medianHandlingSec: null,
    timeSaved: { customerMessages: 0, hours: 0 },
    ticketShare: null,
  },
  resolutionMix: { ai: 0, human: 0, escalated: 0, closed: 0 },
  peaks: emptyPeaks(),
  byNumber: [],
  topicFriction: [],
  team: [],
};

/**
 * `attributionSince` for the fixture worlds (oracle runner; the DB runner
 * checks the SQL against the real migration row, see the DB spec).
 */
export const ATTRIBUTION_SINCE = {
  // Migration finished 2026-10-19T22:30Z = 01:30 on the 20th in Riyadh; the
  // workspace (2026-09-01) is older, so the migration wins.
  world: "2026-10-20",
  // A workspace created after the migration: its own day wins (2026-11-03T21:30Z = 00:30 on the 4th).
  newerWorkspace: "2026-11-04",
  // No migration row.
  noMigration: null,
} as const;

/** Named metric tests → the part of the expectation each one asserts. */
export const SUPPORT_METRIC_TESTS: Record<string, (e: SupportExpectation) => unknown> = {
  "conversations counts distinct conversations with a customer message in range": (e) => e.headline.conversations,
  "ai resolution rate = ai-resolved / decided (nothing decided → null)": (e) => ({
    decided: e.headline.decided,
    aiResolved: e.headline.aiResolved,
    aiResolutionRate: e.headline.aiResolutionRate,
  }),
  "median first response excludes AI-only replies": (e) => ({
    medianFirstResponseSec: e.headline.medianFirstResponseSec,
    unanswered: e.headline.unanswered,
  }),
  "median handling time runs from exchange start to resolvedAt": (e) => e.headline.medianHandlingSec,
  "time saved credits 60 s per customer message answered first by AI": (e) => e.headline.timeSaved,
  "share turned into tickets counts support tickets created from the range's conversations": (e) => e.headline.ticketShare,
  "resolution mix buckets are disjoint and sum to decided": (e) => ({ mix: e.resolutionMix, decided: e.headline.decided }),
  "hour-of-day peaks bucket customer messages in the workspace timezone": (e) => e.peaks,
  "by number splits conversations and ai rate per WhatsApp channel": (e) => e.byNumber,
  "topic friction ranks topics with escalation and negative share": (e) => e.topicFriction,
  "team rows attribute replies to the sending member": (e) => e.team,
};

// ── Sales (SP-11 Task 2) ────────────────────────────────────────────────
// Sales range 2026-11-08 … 2026-11-28 (Riyadh) = [2026-11-07T21:00Z,
// 2026-11-28T21:00Z), pipeline pl-leads, now = 2026-11-30T09:00Z (12:00 local).
// Leads of the range: L1–L11 (L0 was created at 20:30Z on the 7th = 23:30
// local, before the range; tk5 is older).

export interface SalesExpectation {
  headline: { leads: number; replied: number; medianSpeedToReplySec: number | null; waiting: number; won: number };
  distribution: { bucket: string; count: number }[];
  weekly: { weekStart: string; leads: number; won: number }[];
  sources: SourceRow[];
  funnel: FunnelRow[];
  lostReasons: LostReasonRow[];
  reps: RepRow[];
}

const dist = (counts: [lt5: number, m5: number, m15: number, h1: number, h4: number, d1: number, none: number]) =>
  ["lt_5m", "5_15m", "15_60m", "1_4h", "4_24h", "gt_24h", "not_replied"].map((bucket, i) => ({ bucket, count: counts[i] }));

const rep = (userId: string | null, name: string, over: Partial<RepRow> = {}): RepRow => ({
  userId,
  name,
  former: false,
  leads: 0,
  won: 0,
  lost: 0,
  medianSpeedToReplySec: null,
  followUps: { done: 0, overdue: 0, dueToday: 0 },
  ...over,
});

const FUNNEL: FunnelRow[] = [
  // Every lead but L10 (created straight into "contacted"); L4 by its current stage.
  { stageId: ST.new, key: "new", label: "New", labelAr: "جديد", reached: 10, isWon: false, isTerminal: false },
  // L1, L3, L5 (reopened into it), L6, L10.
  { stageId: ST.contacted, key: "contacted", label: "Contacted", labelAr: "تم التواصل", reached: 5, isWon: false, isTerminal: false },
  // The won stage before the lost one, whatever their order: L1, L5.
  { stageId: ST.won, key: "won", label: "Won", labelAr: "فوز", reached: 2, isWon: true, isTerminal: true },
  // L2, L7, L8, L9.
  { stageId: ST.lost, key: "lost", label: "Lost", labelAr: "خسارة", reached: 4, isWon: false, isTerminal: true },
];

// Lost in range: L2 and L9 (Price), L7 (reason deleted, snapshot "Too far"),
// L8 (no reason).
const LOST_REASONS: LostReasonRow[] = [
  { reasonId: "lr-price", label: "Price", labelAr: "السعر", count: 2 },
  { reasonId: null, label: "No reason", labelAr: "بدون سبب", count: 1 },
  { reasonId: null, label: "Too far", labelAr: "Too far", count: 1 },
];

// Arabic workspace: weeks start on Sunday. Leads by local creation day:
// week of 8 Nov: L1, L2, L3, L4, L5, L11 (Sat 14th 09:00 local) = 6; week of
// 15 Nov: L6, L7, L8, L9, L10 = 5; week of 22 Nov: none (present, zeros).
// Won by won-move day, distinct per week: 8 Nov: L0, L1, L5 (13th); 15 Nov:
// L5 again (16th). (The week figures need not sum to `won`: L5 counts in both.)
const WEEKLY = [
  { weekStart: "2026-11-08", leads: 6, won: 3 },
  { weekStart: "2026-11-15", leads: 5, won: 1 },
  { weekStart: "2026-11-22", leads: 0, won: 0 },
];

/** The same world read as an English workspace: Monday weeks. */
export const SALES_WEEKLY_EN = [
  { weekStart: "2026-11-02", leads: 1, won: 0 }, // L1 (Sun 8th)
  { weekStart: "2026-11-09", leads: 6, won: 3 }, // L2–L5, L11, L6 (Sun 15th); won L0, L1, L5
  { weekStart: "2026-11-16", leads: 4, won: 1 }, // L7–L10; L5 won again
  { weekStart: "2026-11-23", leads: 0, won: 0 },
];

/**
 * The owner. replied: all but L4 and L8 (no conversation) = 9 (L3 by the AI
 * only). First staff reply after creation: L1 180 s (<5m), L2 300 (exactly
 * 5 min → 5–15m), L9 900 (15 min → 15–60m), L6 1200, L5 3600 (60 min →
 * 1–4h), L10 14400 (240 min → 4–24h), L11 86400 (1440 min → >24h), L7 93600;
 * L3, L4, L8 none. Median of the eight = (1200 + 3600) / 2 = 2400.
 * waiting (now): open leads L3 (customer wrote after the AI), L6 (latest is
 * the customer on cv26), L11 = 3; L4 has no messages; L10's customer message
 * is on a closed conversation. won: L0, L1, L5 (won, reopened, won) = 3; the
 * deals pipeline's won move does not count.
 */
export const SALES_OWNER: SalesExpectation = {
  headline: { leads: 11, replied: 9, medianSpeedToReplySec: 2400, waiting: 3, won: 3 },
  distribution: dist([1, 1, 2, 1, 1, 2, 3]),
  weekly: WEEKLY,
  // L1, L9 by ad1 (adName), L11 by ad2 (headline: no adName); L2, L5, L6,
  // L7, L10 by their earliest conversation's channel (L5's earliest is cv23,
  // L10's cv29); L3 Instagram; L4, L8 have no conversation: contact source.
  sources: [
    { kind: "channel", key: "whatsapp", label: "whatsapp", leads: 5, won: 1 },
    { kind: "ad", key: "ad1", id: "ad1", label: "Winter sale", leads: 2, won: 1 },
    { kind: "ad", key: "ad2", id: "ad2", label: "Eid offer", leads: 1, won: 0 },
    { kind: "channel", key: "instagram", label: "instagram", leads: 1, won: 0 },
    { kind: "contact_source", key: "manual", label: "manual", leads: 1, won: 0 },
    { kind: "contact_source", key: "meta_lead_form", label: "meta_lead_form", leads: 1, won: 0 },
  ],
  funnel: FUNNEL,
  lostReasons: LOST_REASONS,
  // Badr owns L1, L3, L7, L8, L10, L11 (and L0, won in range); his own replies:
  // L1 180, L10 14400, L11 86400, L7 93600 → median 50400. Sami owns L2, L6,
  // L9 (L9 was answered by Badr, not him): 300, 1200 → 750. L5's owner is a
  // former member (3600); L4 is unowned. Follow-ups (now = 30 Nov 12:00 local):
  // Badr done fu1 (fu2 was done after the range), overdue fu3 and fu5 (due
  // earlier today), due today fu4 (18:00), fu6 is tomorrow; Sami done fu7
  // (fu8 has no due date); Omar done fu11; former overdue fu9; unassigned fu10.
  reps: [
    rep(U.agent, "Badr", { leads: 6, won: 2, lost: 2, medianSpeedToReplySec: 50400, followUps: { done: 1, overdue: 2, dueToday: 1 } }),
    rep(U.assigned, "Sami", { leads: 3, lost: 2, medianSpeedToReplySec: 750, followUps: { done: 1, overdue: 0, dueToday: 0 } }),
    rep(U.admin, "Amal"),
    rep(U.viewer, "Huda"),
    rep(U.owner, "Omar", { followUps: { done: 1, overdue: 0, dueToday: 0 } }),
    rep(null, "Former member", { former: true, leads: 1, won: 1, medianSpeedToReplySec: 3600, followUps: { done: 0, overdue: 1, dueToday: 0 } }),
    rep(null, "Unassigned", { leads: 1, followUps: { done: 0, overdue: 1, dueToday: 0 } }),
  ],
};

/**
 * Sami (assigned-only) sees cv21 (L2), cv23 (L5), cv25 (L6) of the sales
 * conversations. Ticket figures are unchanged; replied L2, L5, L6 = 3; speeds
 * 300, 3600, 1200 → median 1200; waiting 0 (L6's customer message is on
 * Badr's hidden cv26, L3 and L11 are hidden); sources fall back to the
 * contact's source when no conversation is visible; Badr's replies are all on
 * hidden conversations.
 */
export const SALES_ASSIGNED: SalesExpectation = {
  headline: { leads: 11, replied: 3, medianSpeedToReplySec: 1200, waiting: 0, won: 3 },
  distribution: dist([0, 1, 1, 1, 0, 0, 8]),
  weekly: WEEKLY,
  sources: [
    { kind: "contact_source", key: "whatsapp", label: "whatsapp", leads: 4, won: 1 }, // L1, L9, L10, L11
    { kind: "channel", key: "whatsapp", label: "whatsapp", leads: 3, won: 1 }, // L2, L5, L6
    { kind: "contact_source", key: "import", label: "import", leads: 1, won: 0 },
    { kind: "contact_source", key: "instagram", label: "instagram", leads: 1, won: 0 },
    { kind: "contact_source", key: "manual", label: "manual", leads: 1, won: 0 },
    { kind: "contact_source", key: "meta_lead_form", label: "meta_lead_form", leads: 1, won: 0 },
  ],
  funnel: FUNNEL,
  lostReasons: LOST_REASONS,
  reps: SALES_OWNER.reps.map((r) => (r.userId === U.agent ? { ...r, medianSpeedToReplySec: null } : r)),
};

/** A workspace with only the leads pipeline (no members, no tickets). */
export const SALES_EMPTY: SalesExpectation = {
  headline: { leads: 0, replied: 0, medianSpeedToReplySec: null, waiting: 0, won: 0 },
  distribution: dist([0, 0, 0, 0, 0, 0, 0]),
  weekly: WEEKLY.map((w) => ({ ...w, leads: 0, won: 0 })),
  sources: [],
  funnel: FUNNEL.map((f) => ({ ...f, reached: 0 })),
  lostReasons: [],
  reps: [],
};

/** Named sales metric tests → the part of the expectation each one asserts. */
export const SALES_METRIC_TESTS: Record<string, (e: SalesExpectation) => unknown> = {
  "leads counts cards created in range in the pipeline": (e) => e.headline.leads,
  "replied counts leads with a staff or AI message after creation": (e) => e.headline.replied,
  "speed to reply is the median to the first staff reply": (e) => e.headline.medianSpeedToReplySec,
  "speed distribution buckets are exhaustive": (e) => ({
    distribution: e.distribution,
    total: e.distribution.reduce((a, b) => a + b.count, 0) === e.headline.leads,
  }),
  "waiting counts open leads whose latest visible message is the customer's": (e) => e.headline.waiting,
  "won counts distinct cards with a won move in range": (e) => e.headline.won,
  "weekly trend buckets by workspace-local week": (e) => e.weekly,
  "lead sources attribute ad, channel, then contact source": (e) => e.sources,
  "stage funnel counts cards that reached each stage": (e) => e.funnel,
  "lost reasons group by catalog reason with snapshot fallback": (e) => e.lostReasons,
  "reps table totals owners and follow-ups": (e) => e.reps,
};
