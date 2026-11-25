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
  /** Default `contact-<id>` (an implicit contact with source "whatsapp"). */
  contactId?: string;
  /** Conversation.status; default "human". */
  status?: string;
  /** Default 2026-10-01T00:00Z (orders a contact's conversations). */
  createdAt?: Date;
  /** SP-15: the ad that started this thread. */
  adSourceId?: string | null;
}

export interface WorldMessage {
  id: string;
  conversationId: string;
  from: From;
  createdAt: Date;
  sentById?: string | null;
}

export interface WorldStage {
  id: string;
  key: string;
  label: string;
  labelAr: string;
  order: number;
  isTerminal?: boolean;
  isWon?: boolean;
}

export interface WorldPipeline {
  id: string;
  key: string;
  kind: "support" | "leads" | "deals";
  name: string;
  /** First stage = where tickets start by default. */
  stages: WorldStage[];
  createdAt: Date;
  isDefault?: boolean;
  archivedAt?: Date | null;
}

export interface WorldTicket {
  id: string;
  pipelineId: string;
  conversationId: string | null;
  createdAt: Date;
  /** Default: the conversation's contact. */
  contactId?: string;
  /** Default: the pipeline's first stage. */
  stageId?: string;
  ownerId?: string | null;
  closedAt?: Date | null;
  lostReasonId?: string | null;
  /** Label snapshot (survives the reason's deletion). */
  lostReason?: string | null;
}

export interface WorldContact {
  id: string;
  source: string;
}

export interface WorldAdSource {
  id: string;
  sourceId: string;
  adName: string | null;
  headline: string | null;
}

export interface WorldLostReason {
  id: string;
  pipelineId: string;
  label: string;
  labelAr: string;
}

export interface WorldTicketActivity {
  id: string;
  ticketId: string;
  kind: "created" | "stage_changed" | "won" | "lost";
  toStage: string | null;
  createdAt: Date;
}

/** SP-04 follow-up. */
export interface WorldFollowUp {
  id: string;
  assigneeId: string | null;
  dueAt: Date | null;
  doneAt: Date | null;
}

export interface InsightsWorld {
  workspace: { name: string; timezone: string; lang: "ar" | "en"; /** UTC ISO without Z. */ createdAt?: string };
  /** When the insights_home migration finished (UTC ISO without Z); null = no row. */
  migrationAppliedAt?: string | null;
  roles: WorldRole[];
  users: WorldUser[];
  channels: WorldChannel[];
  conversations: WorldConversation[];
  messages: WorldMessage[];
  pipelines: WorldPipeline[];
  tickets: WorldTicket[];
  /** Contacts beyond the implicit one per conversation. */
  contacts?: WorldContact[];
  adSources?: WorldAdSource[];
  lostReasons?: WorldLostReason[];
  ticketActivities?: WorldTicketActivity[];
  followUps?: WorldFollowUp[];
}

/** The contact a conversation belongs to. */
export const contactOf = (c: WorldConversation) => c.contactId ?? `contact-${c.id}`;
/** A conversation's createdAt (default 2026-10-01). */
export const conversationCreatedAt = (c: WorldConversation) => c.createdAt ?? new Date("2026-10-01T00:00:00Z");
/** Every contact of the world, implicit ones included (source "whatsapp"). */
export function worldContacts(w: InsightsWorld): WorldContact[] {
  const out = new Map<string, WorldContact>();
  for (const c of w.conversations) if (!c.contactId) out.set(contactOf(c), { id: contactOf(c), source: "whatsapp" });
  for (const c of w.contacts ?? []) out.set(c.id, c);
  return [...out.values()];
}
/** A ticket's contact. */
export function ticketContact(w: InsightsWorld, t: WorldTicket): string {
  if (t.contactId) return t.contactId;
  const conv = w.conversations.find((c) => c.id === t.conversationId);
  if (!conv) throw new Error(`fixture ticket ${t.id} has no contact`);
  return contactOf(conv);
}
/** A ticket's stage id. */
export function ticketStage(w: InsightsWorld, t: WorldTicket): string {
  if (t.stageId) return t.stageId;
  const p = w.pipelines.find((x) => x.id === t.pipelineId);
  if (!p) throw new Error(`fixture ticket ${t.id}: unknown pipeline`);
  return p.stages[0].id;
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


// ── Sales (SP-11 Task 2) ────────────────────────────────────────────────
// Sales range 2026-11-08 … 2026-11-28 (Riyadh) = [2026-11-07T21:00Z,
// 2026-11-28T21:00Z): three Sunday-to-Saturday weeks; the third is empty.
// Every sales message is after the support range, and no sales conversation
// has a verdict, so the support expectations are unaffected.

export const SALES_RANGE = { from: "2026-11-08", to: "2026-11-28" } as const;
/** "Now" for the sales reads (waiting, follow-ups): Mon 30 Nov, 12:00 Riyadh. */
export const SALES_NOW = new Date("2026-11-30T09:00:00Z");

export const ST = {
  new: "st-leads-new",
  contacted: "st-leads-contacted",
  won: "st-leads-won",
  lost: "st-leads-lost",
} as const;

const SALES_PIPELINES: WorldPipeline[] = [
  {
    // Archived and older: never the default.
    id: "pl-leads-old",
    key: "leads_old",
    kind: "leads",
    name: "Old leads",
    createdAt: at("2026-08-01T00:00:00"),
    archivedAt: at("2026-08-15T00:00:00"),
    stages: [{ id: "st-old-new", key: "new", label: "New", labelAr: "جديد", order: 0 }],
  },
  {
    id: "pl-deals",
    key: "deals",
    kind: "deals",
    name: "Deals",
    isDefault: true,
    createdAt: at("2026-09-02T00:00:00"),
    stages: [
      { id: "st-deals-open", key: "open", label: "Open", labelAr: "مفتوحة", order: 0 },
      { id: "st-deals-won", key: "won", label: "Won", labelAr: "تم الفوز", order: 1, isTerminal: true, isWon: true },
    ],
  },
  {
    // The first non-archived leads pipeline: the default for sales insights.
    id: "pl-leads",
    key: "leads",
    kind: "leads",
    name: "Leads",
    createdAt: at("2026-09-03T00:00:00"),
    stages: [
      { id: "st-leads-new", key: "new", label: "New", labelAr: "جديد", order: 0 },
      { id: "st-leads-contacted", key: "contacted", label: "Contacted", labelAr: "تم التواصل", order: 1 },
      { id: "st-leads-lost", key: "lost", label: "Lost", labelAr: "خسارة", order: 2, isTerminal: true },
      { id: "st-leads-won", key: "won", label: "Won", labelAr: "فوز", order: 3, isTerminal: true, isWon: true },
    ],
  },
  {
    id: "pl-leads-2",
    key: "leads_2",
    kind: "leads",
    name: "Leads 2",
    createdAt: at("2026-09-10T00:00:00"),
    stages: [{ id: "st-leads2-new", key: "new", label: "New", labelAr: "جديد", order: 0 }],
  },
];

const salesConv = (
  id: string,
  contactId: string,
  channelId: string | null,
  assigneeId: string | null,
  createdAt: string,
  over: Partial<WorldConversation> = {},
): WorldConversation => ({
  id,
  contactId,
  channel: channelId === CH.ig ? "instagram" : "whatsapp",
  channelId,
  assigneeId,
  createdAt: at(createdAt),
  ...over,
});

const SALES_CONVERSATIONS: WorldConversation[] = [
  salesConv("cv20", "ct-l1", CH.a, U.agent, "2026-11-08T09:58:00", { adSourceId: "ad1" }),
  salesConv("cv21", "ct-l2", CH.b, U.assigned, "2026-11-09T11:50:00"),
  salesConv("cv22", "ct-l3", CH.ig, null, "2026-11-10T07:55:00"),
  salesConv("cv23", "ct-l5", CH.a, U.assigned, "2026-11-12T09:00:00"),
  salesConv("cv24", "ct-l5", CH.b, U.agent, "2026-11-12T12:00:00"),
  salesConv("cv25", "ct-l6", CH.a, U.assigned, "2026-11-15T09:00:00"),
  salesConv("cv26", "ct-l6", CH.b, U.agent, "2026-11-15T12:00:00"),
  salesConv("cv27", "ct-l7", CH.b, U.agent, "2026-11-17T09:00:00"),
  salesConv("cv28", "ct-l9", CH.a, U.agent, "2026-11-20T09:00:00", { adSourceId: "ad1" }),
  salesConv("cv29", "ct-l10", CH.b, U.agent, "2026-11-21T05:00:00"),
  salesConv("cv30", "ct-l11", CH.a, U.agent, "2026-11-14T05:00:00", { adSourceId: "ad2" }),
  // Closed: its customer message never makes L10 "waiting".
  salesConv("cv31", "ct-l10", CH.a, U.agent, "2026-11-21T11:00:00", { status: "closed" }),
];

const SALES_CONTACTS: WorldContact[] = [
  { id: "ct-l0", source: "manual" },
  { id: "ct-l1", source: "whatsapp" },
  { id: "ct-l2", source: "whatsapp" },
  { id: "ct-l3", source: "instagram" },
  { id: "ct-l4", source: "meta_lead_form" },
  { id: "ct-l5", source: "whatsapp" },
  { id: "ct-l6", source: "whatsapp" },
  { id: "ct-l7", source: "import" },
  { id: "ct-l8", source: "manual" },
  { id: "ct-l9", source: "whatsapp" },
  { id: "ct-l10", source: "whatsapp" },
  { id: "ct-l11", source: "whatsapp" },
];

const SALES_AD_SOURCES: WorldAdSource[] = [
  { id: "ad1", sourceId: "120001", adName: "Winter sale", headline: "Winter" },
  { id: "ad2", sourceId: "120002", adName: null, headline: "Eid offer" },
];

const SALES_LOST_REASONS: WorldLostReason[] = [
  { id: "lr-price", pipelineId: "pl-leads", label: "Price", labelAr: "السعر" },
  { id: "lr-timing", pipelineId: "pl-leads", label: "Timing", labelAr: "التوقيت" },
];

let sm = 0;
const smsg = (conversationId: string, from: From, iso: string, sentById: string | null = null): WorldMessage => ({
  id: `${conversationId}-s${String(++sm).padStart(2, "0")}`,
  conversationId,
  from,
  createdAt: at(iso),
  sentById,
});

const SALES_MESSAGES: WorldMessage[] = [
  smsg("cv20", "them", "2026-11-08T09:58:00"),
  smsg("cv20", "ai", "2026-11-08T10:01:00"),
  smsg("cv20", "human", "2026-11-08T10:03:00", U.agent),

  smsg("cv21", "them", "2026-11-09T11:50:00"),
  smsg("cv21", "human", "2026-11-09T12:05:00", U.assigned),

  smsg("cv22", "them", "2026-11-10T07:55:00"),
  smsg("cv22", "ai", "2026-11-10T08:01:00"),
  smsg("cv22", "them", "2026-11-10T08:30:00"),

  smsg("cv23", "them", "2026-11-12T09:00:00"),
  smsg("cv23", "human", "2026-11-12T11:00:00", U.former),
  smsg("cv24", "them", "2026-11-12T12:00:00"),

  smsg("cv25", "them", "2026-11-15T09:00:00"),
  smsg("cv25", "human", "2026-11-15T10:20:00", U.assigned),
  smsg("cv26", "them", "2026-11-15T12:00:00"),

  smsg("cv27", "them", "2026-11-17T09:00:00"),
  smsg("cv27", "human", "2026-11-18T12:00:00", U.agent),

  smsg("cv28", "them", "2026-11-20T09:00:00"),
  smsg("cv28", "human", "2026-11-20T10:15:00", U.agent),

  smsg("cv29", "them", "2026-11-21T05:00:00"),
  smsg("cv29", "human", "2026-11-21T10:00:00", U.agent),
  smsg("cv31", "them", "2026-11-21T12:00:00"),

  smsg("cv30", "them", "2026-11-14T05:00:00"),
  smsg("cv30", "human", "2026-11-15T06:00:00", U.agent),
  smsg("cv30", "them", "2026-11-15T07:00:00"),
];

const lead = (
  id: string,
  contactId: string,
  created: string,
  ownerId: string | null,
  stageId: string,
  over: Partial<WorldTicket> = {},
): WorldTicket => ({
  id,
  pipelineId: "pl-leads",
  conversationId: null,
  contactId,
  createdAt: at(created),
  ownerId,
  stageId,
  closedAt: stageId === ST.won || stageId === ST.lost ? at("2026-11-25T00:00:00") : null,
  ...over,
});

const SALES_TICKETS: WorldTicket[] = [
  // Before the range, won inside it.
  lead("tk-l0", "ct-l0", "2026-11-07T20:30:00", U.agent, ST.won),
  lead("tk-l1", "ct-l1", "2026-11-08T10:00:00", U.agent, ST.won),
  lead("tk-l2", "ct-l2", "2026-11-09T12:00:00", U.assigned, ST.lost, { lostReasonId: "lr-price", lostReason: "Price" }),
  lead("tk-l3", "ct-l3", "2026-11-10T08:00:00", U.agent, ST.contacted),
  // No activities at all (a legacy row): reaches "new" by its current stage.
  lead("tk-l4", "ct-l4", "2026-11-11T09:00:00", null, ST.new),
  lead("tk-l5", "ct-l5", "2026-11-12T10:00:00", U.former, ST.won),
  lead("tk-l6", "ct-l6", "2026-11-15T10:00:00", U.assigned, ST.contacted),
  // Its catalog reason was deleted: the snapshot remains.
  lead("tk-l7", "ct-l7", "2026-11-17T10:00:00", U.agent, ST.lost, { lostReasonId: null, lostReason: "Too far" }),
  lead("tk-l8", "ct-l8", "2026-11-19T10:00:00", U.agent, ST.lost, { lostReasonId: null, lostReason: null }),
  lead("tk-l9", "ct-l9", "2026-11-20T10:00:00", U.assigned, ST.lost, { lostReasonId: "lr-price", lostReason: "Price" }),
  // Created straight into "contacted".
  lead("tk-l10", "ct-l10", "2026-11-21T06:00:00", U.agent, ST.contacted),
  lead("tk-l11", "ct-l11", "2026-11-14T06:00:00", U.agent, ST.new),
  // Another pipeline: a won move here never counts.
  {
    id: "tk-d1",
    pipelineId: "pl-deals",
    conversationId: null,
    contactId: "ct-l1",
    createdAt: at("2026-11-09T08:00:00"),
    ownerId: U.agent,
    stageId: "st-deals-won",
    closedAt: at("2026-11-10T08:00:00"),
  },
];

let ta = 0;
const act = (ticketId: string, kind: WorldTicketActivity["kind"], toStage: string | null, iso: string): WorldTicketActivity => ({
  id: `ta-${String(++ta).padStart(2, "0")}`,
  ticketId,
  kind,
  toStage,
  createdAt: at(iso),
});

const SALES_TICKET_ACTIVITIES: WorldTicketActivity[] = [
  act("tk-l0", "created", "new", "2026-11-07T20:30:00"),
  act("tk-l0", "won", "won", "2026-11-09T10:00:00"),
  act("tk-l1", "created", "new", "2026-11-08T10:00:00"),
  act("tk-l1", "stage_changed", "contacted", "2026-11-08T11:00:00"),
  act("tk-l1", "won", "won", "2026-11-09T09:00:00"),
  act("tk-l2", "created", "new", "2026-11-09T12:00:00"),
  act("tk-l2", "lost", "lost", "2026-11-10T08:00:00"),
  act("tk-l3", "created", "new", "2026-11-10T08:00:00"),
  act("tk-l3", "stage_changed", "contacted", "2026-11-10T09:00:00"),
  // Won, reopened, won again: one card.
  act("tk-l5", "created", "new", "2026-11-12T10:00:00"),
  act("tk-l5", "won", "won", "2026-11-13T10:00:00"),
  act("tk-l5", "stage_changed", "contacted", "2026-11-14T10:00:00"),
  act("tk-l5", "won", "won", "2026-11-16T10:00:00"),
  act("tk-l6", "created", "new", "2026-11-15T10:00:00"),
  act("tk-l6", "stage_changed", "contacted", "2026-11-15T11:00:00"),
  act("tk-l7", "created", "new", "2026-11-17T10:00:00"),
  act("tk-l7", "lost", "lost", "2026-11-18T10:00:00"),
  act("tk-l8", "created", "new", "2026-11-19T10:00:00"),
  act("tk-l8", "lost", "lost", "2026-11-19T12:00:00"),
  act("tk-l9", "created", "new", "2026-11-20T10:00:00"),
  act("tk-l9", "lost", "lost", "2026-11-20T14:00:00"),
  act("tk-l10", "created", "contacted", "2026-11-21T06:00:00"),
  act("tk-l11", "created", "new", "2026-11-14T06:00:00"),
  act("tk-d1", "won", "won", "2026-11-10T08:00:00"),
];

const fu = (id: string, assigneeId: string | null, dueAt: string | null, doneAt: string | null): WorldFollowUp => ({
  id,
  assigneeId,
  dueAt: dueAt ? at(dueAt) : null,
  doneAt: doneAt ? at(doneAt) : null,
});

const SALES_FOLLOW_UPS: WorldFollowUp[] = [
  fu("fu1", U.agent, "2026-11-10T10:00:00", "2026-11-10T10:00:00"), // done in range
  fu("fu2", U.agent, "2026-11-29T09:00:00", "2026-11-29T10:00:00"), // done after the range
  fu("fu3", U.agent, "2026-11-25T10:00:00", null), // overdue
  fu("fu4", U.agent, "2026-11-30T15:00:00", null), // due later today (18:00 local)
  fu("fu5", U.agent, "2026-11-30T08:00:00", null), // earlier today, already past: overdue
  fu("fu6", U.agent, "2026-11-30T21:30:00", null), // tomorrow 00:30 local
  fu("fu7", U.assigned, "2026-11-20T10:00:00", "2026-11-20T10:00:00"),
  fu("fu8", U.assigned, null, null), // no due date
  fu("fu9", U.former, "2026-11-28T10:00:00", null), // overdue, former member
  fu("fu10", null, "2026-11-26T10:00:00", null), // overdue, unassigned
  fu("fu11", U.owner, "2026-11-12T10:00:00", "2026-11-12T10:00:00"),
  // Done long before the range: never read by the reps statement, never counted.
  fu("fu12", U.agent, "2026-10-01T10:00:00", "2026-10-01T11:00:00"),
];

export const INSIGHTS_WORLD: InsightsWorld = {
  workspace: { name: "Insights world", timezone: "Asia/Riyadh", lang: "ar", createdAt: "2026-09-01T08:00:00" },
  // 22:30Z on the 19th is 01:30 on the 20th in Riyadh: the local day counts.
  migrationAppliedAt: "2026-10-19T22:30:00",
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
    ...SALES_CONVERSATIONS,
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
    ...SALES_MESSAGES,
  ],
  pipelines: [
    {
      id: "pl-support",
      key: "support",
      kind: "support",
      name: "Support",
      createdAt: at("2026-09-01T00:00:00"),
      stages: [{ id: "st-support-open", key: "open", label: "New", labelAr: "جديدة", order: 0 }],
    },
    ...SALES_PIPELINES,
  ],
  tickets: [
    { id: "tk1", pipelineId: "pl-support", conversationId: "cv6", createdAt: at("2026-11-06T09:30:00") },
    { id: "tk2", pipelineId: "pl-support", conversationId: "cv6", createdAt: at("2026-11-06T09:40:00") },
    { id: "tk3", pipelineId: "pl-support", conversationId: "cv3", createdAt: at("2026-11-05T08:00:00") },
    { id: "tk4", pipelineId: "pl-support", conversationId: "cv7", createdAt: at("2026-10-30T10:00:00") },
    { id: "tk5", pipelineId: "pl-leads", conversationId: "cv7", createdAt: at("2026-11-02T05:01:00") },
    { id: "tk6", pipelineId: "pl-support", conversationId: "cv8", createdAt: at("2026-11-01T11:00:00") },
    ...SALES_TICKETS,
  ],
  contacts: SALES_CONTACTS,
  adSources: SALES_AD_SOURCES,
  lostReasons: SALES_LOST_REASONS,
  ticketActivities: SALES_TICKET_ACTIVITIES,
  followUps: SALES_FOLLOW_UPS,
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

/** Only the leads pipeline: no members, no tickets (sales "no data"). */
export const EMPTY_SALES_WORLD: InsightsWorld = {
  ...EMPTY_WORLD,
  workspace: { ...EMPTY_WORLD.workspace, name: "Empty sales world" },
  pipelines: SALES_PIPELINES.filter((p) => p.id === "pl-leads"),
};
