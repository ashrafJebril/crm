/**
 * Hand-written expected values for the SP-11 fixture world
 * (`__fixtures__/insights-world.ts`), range 2026-11-01 … 2026-11-07 in
 * Asia/Riyadh = [2026-10-31T21:00Z, 2026-11-07T21:00Z). Worked by hand from
 * the plan's metric definitions; the reasoning is next to each value. Both
 * the TS oracle and the real SQL must produce exactly these.
 */
import { CH, U } from "./__fixtures__/insights-world";
import type { ByNumberRow, Peaks, ResolutionMix, SupportHeadline, TeamRow, TopicFrictionRow } from "./insights.dto";
import { emptyPeaks } from "./insights-format";

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
