import type { Section } from "../insights/insights.dto";

/**
 * SP-11 working home (`GET /home`), mirrored in the frontend's
 * `src/lib/types.ts`. Every list and count is computed as the member, with
 * their permissions and conversation scope. A part the member has no
 * permission for is `forbidden` (the UI hides it); a part that failed, timed
 * out or needs a column the database does not have yet (ruling 11) is
 * `unavailable`. Times are ISO strings.
 */

export interface WaitingConversationRow {
  id: string;
  contactName: string;
  channel: string;
  /** The first customer message since the last reply (the unanswered run's start). */
  waitingSince: string;
  assigneeId: string | null;
  escalated: boolean;
}

export interface FollowUpRow {
  id: string;
  title: string;
  kind: string;
  dueAt: string | null;
  contactId: string | null;
  ticketId: string | null;
}

export interface TicketRow {
  id: string;
  number: number;
  title: string;
  contactName: string | null;
  createdAt: string;
  /** SP-09; null when unset (or before SP-09 shipped). */
  slaDueAt: string | null;
  priority: string | null;
}

export interface BookingRow {
  id: string;
  startAt: string;
  durationMin: number;
  service: string;
  serviceAr: string;
  status: string;
  contactName: string | null;
}

export interface ListSection<T> {
  /** Every matching row; `items` holds at most HOME_LIST_CAP of them. */
  total: number;
  items: T[];
}

export interface HomeDay {
  followUps: Section<FollowUpRow[]>;
  bookings: Section<BookingRow[]>;
  ticketsDue: Section<TicketRow[]>;
}

export interface AwaySummary {
  /** `homeSeenAt`, or 24 h before now when the member has never looked. */
  since: string;
  /** null = the member may not see that kind of record. */
  aiReplies: number | null;
  aiResolved: number | null;
  agentBookings: number | null;
  autoTickets: number | null;
  /** At most 5 conversations the AI resolved since then, newest first. */
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
    waitingConversations: Section<ListSection<WaitingConversationRow>>;
    lateFollowUps: Section<ListSection<FollowUpRow>>;
    unassignedTickets: Section<ListSection<TicketRow>>;
  };
  today: HomeDay;
  tomorrow: HomeDay;
  away: Section<AwaySummary>;
  /** `canDismiss` is false for a session without a member row (super-admin,
   *  impersonation): `POST /home/day1/dismiss` would be a no-op for it. */
  day1: { show: boolean; steps: Day1Step[]; canDismiss: boolean };
}
