// SP-11 working home (`GET /home`). Mirrors backend/src/home/home.dto.ts.
// Kept in its own file (not types.ts) so it never conflicts with the insights
// types appended there by SP-11 Task 4.

/** One independently computed part of the home. `forbidden` parts are hidden;
 *  `unavailable` parts say so (failed, timed out, or not shipped yet). */
export type HomeSection<T> = { status: "ok"; data: T } | { status: "unavailable" } | { status: "forbidden" };

export interface WaitingConversationRow {
  id: string;
  contactName: string;
  channel: string;
  /** The first customer message since the last reply. */
  waitingSince: string;
  assigneeId: string | null;
  escalated: boolean;
}

export interface HomeFollowUpRow {
  id: string;
  title: string;
  kind: string;
  dueAt: string | null;
  contactId: string | null;
  ticketId: string | null;
}

export interface HomeTicketRow {
  id: string;
  number: number;
  title: string;
  contactName: string | null;
  createdAt: string;
  slaDueAt: string | null;
  priority: string | null;
}

export interface HomeBookingRow {
  id: string;
  startAt: string;
  durationMin: number;
  service: string;
  serviceAr: string;
  status: string;
  contactName: string | null;
}

export interface HomeList<T> {
  total: number;
  items: T[];
}

export interface HomeDay {
  followUps: HomeSection<HomeFollowUpRow[]>;
  bookings: HomeSection<HomeBookingRow[]>;
  ticketsDue: HomeSection<HomeTicketRow[]>;
}

export interface AwaySummary {
  since: string;
  /** null = the member may not see that kind of record. */
  aiReplies: number | null;
  aiResolved: number | null;
  agentBookings: number | null;
  autoTickets: number | null;
  conversations: { id: string; contactName: string | null; resolvedAt: string }[];
}

export type Day1StepKey = "connect_channel" | "add_knowledge" | "invite_team" | "set_pipeline" | "add_services" | "first_reply";

export interface Day1Step {
  key: Day1StepKey;
  done: boolean;
  href: string;
}

export interface HomeDto {
  now: string;
  tz: string;
  needsPerson: {
    waitingConversations: HomeSection<HomeList<WaitingConversationRow>>;
    lateFollowUps: HomeSection<HomeList<HomeFollowUpRow>>;
    unassignedTickets: HomeSection<HomeList<HomeTicketRow>>;
  };
  today: HomeDay;
  tomorrow: HomeDay;
  away: HomeSection<AwaySummary>;
  /** `canDismiss` false: a super-admin / impersonation session (no member row). */
  day1: { show: boolean; steps: Day1Step[]; canDismiss?: boolean };
}
