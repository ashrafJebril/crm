/**
 * SP-11 shared fixture world (ruling 12). One workspace in Asia/Riyadh with
 * members of every system role, an assigned-only agent and a former member,
 * two WhatsApp numbers and one Instagram account, conversations and messages
 * with exact timestamps, resolution verdicts and tickets.
 *
 * Every metric's expected value is written by hand in `insights-expected.ts`
 * and checked twice: by the TS oracle over these rows (always) and by the
 * real SQL over the same rows seeded into Postgres (`support-metrics.db.spec`).
 *
 * The report range is 2026-11-01 … 2026-11-07 (Riyadh), i.e.
 * [2026-10-31T21:00Z, 2026-11-07T21:00Z). 2026-11-01 is a Sunday.
 * Ids are logical; `world-seed.ts` prefixes them per run.
 * No two messages of one conversation share a timestamp (ordering is by
 * `createdAt, id`, and Postgres and JS order ids differently).
 */

export type From = "them" | "ai" | "human";

export interface WorldUser {
  id: string;
  name: string;
  /** Legacy WorkspaceMember.role; null = not a member (a former member). */
  role: "owner" | "admin" | "agent" | "viewer" | "custom" | null;
  /** Custom role id (role "custom"). */
  roleId?: string;
}

export interface WorldRole {
  id: string;
  name: string;
  permissions: Record<string, string[]>;
  conversationVisibility: "all" | "assigned";
}

export interface WorldChannel {
  id: string;
  kind: "whatsapp" | "instagram";
  provider: string;
  externalId: string;
  displayName: string;
}

export interface WorldConversation {
  id: string;
  channel: string;
  channelId: string | null;
  assigneeId: string | null;
  escalated?: boolean;
  resolutionStatus?: "resolved" | "closed" | "open" | null;
  resolution?: string | null;
  resolutionIssue?: "complaint" | "escalation" | "none" | null;
  resolutionSentiment?: "positive" | "neutral" | "negative" | null;
  resolvedAt?: Date | null;
  topics?: unknown;
}

export interface WorldMessage {
  id: string;
  conversationId: string;
  from: From;
  createdAt: Date;
  sentById?: string | null;
}

export interface WorldPipeline {
  id: string;
  key: string;
  kind: "support" | "leads" | "deals";
  name: string;
  stageId: string;
}

export interface WorldTicket {
  id: string;
  pipelineId: string;
  conversationId: string | null;
  createdAt: Date;
}

export interface InsightsWorld {
  workspace: { name: string; timezone: string; lang: "ar" | "en" };
  roles: WorldRole[];
  users: WorldUser[];
  channels: WorldChannel[];
  conversations: WorldConversation[];
  messages: WorldMessage[];
  pipelines: WorldPipeline[];
  tickets: WorldTicket[];
}

const at = (iso: string) => new Date(`${iso}Z`);

export const RANGE = { from: "2026-11-01", to: "2026-11-07" } as const;

export const U = {
  owner: "u-owner",
  admin: "u-admin",
  agent: "u-agent",
  viewer: "u-viewer",
  assigned: "u-assigned",
  former: "u-former",
} as const;

export const CH = { a: "ch-wa-a", b: "ch-wa-b", ig: "ch-ig" } as const;

let n = 0;
const msg = (conversationId: string, from: From, iso: string, sentById: string | null = null): WorldMessage => ({
  id: `${conversationId}-m${String(++n).padStart(2, "0")}`,
  conversationId,
  from,
  createdAt: at(iso),
  sentById,
});

export const INSIGHTS_WORLD: InsightsWorld = {
  workspace: { name: "Insights world", timezone: "Asia/Riyadh", lang: "ar" },
  roles: [
    {
      id: "role-assigned",
      name: "Assigned agent",
      permissions: { conversations: ["view", "update"], reports: ["view"], tickets: ["view"] },
      conversationVisibility: "assigned",
    },
  ],
  users: [
    { id: U.owner, name: "Omar", role: "owner" },
    { id: U.admin, name: "Amal", role: "admin" },
    { id: U.agent, name: "Badr", role: "agent" },
    { id: U.viewer, name: "Huda", role: "viewer" },
    { id: U.assigned, name: "Sami", role: "custom", roleId: "role-assigned" },
    { id: U.former, name: "Fadi", role: null },
  ],
  channels: [
    { id: CH.a, kind: "whatsapp", provider: "zernio", externalId: "acc-a", displayName: "Riyadh line" },
    { id: CH.b, kind: "whatsapp", provider: "zernio", externalId: "acc-b", displayName: "Jeddah line" },
    { id: CH.ig, kind: "instagram", provider: "zernio", externalId: "acc-ig", displayName: "Instagram" },
  ],
  conversations: [
    // AI-only exchange; AI-resolved.
    { id: "cv1", channel: "whatsapp", channelId: CH.a, assigneeId: U.agent, resolutionStatus: "resolved", resolution: "resolved", resolutionIssue: "none", resolutionSentiment: "positive", resolvedAt: at("2026-11-02T12:00:00"), topics: ["Delivery", "Pricing"] },
    // AI first, staff 12 min later; resolved by a person (issue NULL must not hide it).
    { id: "cv2", channel: "whatsapp", channelId: CH.a, assigneeId: U.agent, resolutionStatus: "resolved", resolution: "resolved", resolutionIssue: null, resolutionSentiment: "neutral", resolvedAt: at("2026-11-03T09:00:00"), topics: ["delivery ", "Refund", "Delivery", "pricing"] },
    // Staff in 3 min, at 23:30 Riyadh; closed unresolved.
    { id: "cv3", channel: "whatsapp", channelId: CH.b, assigneeId: U.assigned, resolutionStatus: "closed", resolution: "abandoned", resolutionIssue: "none", resolutionSentiment: "negative", resolvedAt: at("2026-11-05T10:00:00"), topics: ["Refund"] },
    // Unanswered; assigned to a former member.
    { id: "cv4", channel: "whatsapp", channelId: CH.b, assigneeId: U.former },
    // Exchange started before `from`; escalation verdict.
    { id: "cv5", channel: "whatsapp", channelId: CH.a, assigneeId: U.assigned, resolutionStatus: "resolved", resolution: "resolved", resolutionIssue: "escalation", resolutionSentiment: "negative", resolvedAt: at("2026-11-01T06:00:00"), topics: ["Refund", "delivery"] },
    // Instagram; escalated; answered by a former member; two support tickets.
    { id: "cv6", channel: "instagram", channelId: CH.ig, assigneeId: U.agent, escalated: true, resolutionStatus: "resolved", resolution: "resolved", resolutionIssue: "complaint", resolutionSentiment: "negative", resolvedAt: at("2026-11-06T10:00:00"), topics: ["Refund", "Delivery"] },
    // A legacy staff reply (no sender) and an AI-only second exchange; still open.
    { id: "cv7", channel: "whatsapp", channelId: CH.a, assigneeId: U.owner, resolutionStatus: "open" },
    // Decided in range, exchange before range (handling time reaches back).
    { id: "cv8", channel: "whatsapp", channelId: CH.a, assigneeId: U.agent, resolutionStatus: "resolved", resolution: "resolved", resolutionIssue: "none", resolutionSentiment: "positive", resolvedAt: at("2026-11-01T10:00:00"), topics: ["Delivery"] },
    // Decided in range; its only exchange is older than the 7-day lookback.
    { id: "cv9", channel: "whatsapp", channelId: CH.a, assigneeId: U.assigned, resolutionStatus: "resolved", resolution: "resolved", resolutionIssue: "none", resolutionSentiment: "neutral", resolvedAt: at("2026-11-02T10:00:00"), topics: ["delivery"] },
    // No channel row: the "Unassigned number"; last minute of the range.
    { id: "cv10", channel: "whatsapp", channelId: null, assigneeId: null },
    // Starts exactly at the exclusive end of the range.
    { id: "cv11", channel: "whatsapp", channelId: CH.a, assigneeId: U.admin },
    // Decided one minute before the range.
    { id: "cv12", channel: "whatsapp", channelId: CH.a, assigneeId: U.agent, resolutionStatus: "resolved", resolution: "resolved", resolutionIssue: "none", resolutionSentiment: "positive", resolvedAt: at("2026-10-31T20:59:00"), topics: ["Delivery"] },
  ],
  messages: [
    msg("cv1", "them", "2026-11-02T10:00:00"),
    msg("cv1", "ai", "2026-11-02T10:01:00"),

    msg("cv2", "them", "2026-11-03T08:00:00"),
    msg("cv2", "ai", "2026-11-03T08:01:00"),
    msg("cv2", "human", "2026-11-03T08:12:00", U.agent),

    msg("cv3", "them", "2026-11-04T20:30:00"),
    msg("cv3", "human", "2026-11-04T20:33:00", U.assigned),

    msg("cv4", "them", "2026-11-05T21:30:00"),

    msg("cv5", "them", "2026-10-31T20:50:00"),
    msg("cv5", "them", "2026-10-31T21:05:00"),
    msg("cv5", "human", "2026-10-31T21:20:00", U.assigned),

    msg("cv6", "them", "2026-11-06T09:00:00"),
    msg("cv6", "human", "2026-11-06T09:20:00", U.former),

    msg("cv7", "them", "2026-11-02T05:00:00"),
    msg("cv7", "human", "2026-11-02T05:02:00", null),
    msg("cv7", "them", "2026-11-02T06:00:00"),
    msg("cv7", "ai", "2026-11-02T06:00:30"),

    msg("cv8", "them", "2026-10-30T10:00:00"),
    msg("cv8", "ai", "2026-10-30T10:02:00"),

    msg("cv9", "them", "2026-10-20T10:00:00"),
    msg("cv9", "human", "2026-10-20T10:05:00", U.assigned),

    msg("cv10", "them", "2026-11-07T20:59:00"),
    msg("cv10", "ai", "2026-11-07T21:00:30"),

    msg("cv11", "them", "2026-11-07T21:00:00"),
    msg("cv11", "human", "2026-11-07T21:05:00", U.admin),

    msg("cv12", "them", "2026-10-31T19:00:00"),
    msg("cv12", "ai", "2026-10-31T19:01:00"),
  ],
  pipelines: [
    { id: "pl-support", key: "support", kind: "support", name: "Support", stageId: "st-support-open" },
    { id: "pl-leads", key: "leads", kind: "leads", name: "Leads", stageId: "st-leads-new" },
  ],
  tickets: [
    { id: "tk1", pipelineId: "pl-support", conversationId: "cv6", createdAt: at("2026-11-06T09:30:00") },
    { id: "tk2", pipelineId: "pl-support", conversationId: "cv6", createdAt: at("2026-11-06T09:40:00") },
    { id: "tk3", pipelineId: "pl-support", conversationId: "cv3", createdAt: at("2026-11-05T08:00:00") },
    { id: "tk4", pipelineId: "pl-support", conversationId: "cv7", createdAt: at("2026-10-30T10:00:00") },
    { id: "tk5", pipelineId: "pl-leads", conversationId: "cv7", createdAt: at("2026-11-02T05:01:00") },
    { id: "tk6", pipelineId: "pl-support", conversationId: "cv8", createdAt: at("2026-11-01T11:00:00") },
  ],
};

/** A workspace with nothing in it (`rates and medians are null on empty input`). */
export const EMPTY_WORLD: InsightsWorld = {
  workspace: { name: "Empty insights world", timezone: "Asia/Riyadh", lang: "ar" },
  roles: [],
  users: [],
  channels: [],
  conversations: [],
  messages: [],
  pipelines: [],
  tickets: [],
};
