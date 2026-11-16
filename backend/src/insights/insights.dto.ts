/**
 * SP-11 response shapes (mirrored in the frontend's `src/lib/types.ts`).
 * Null is "no data", never 0: a rate or median with an empty denominator is
 * null. Every count is a plain number.
 */

/** One independently computed block of a report. A section that timed out
 *  or failed is `unavailable` (the others still answer); one the member has
 *  no permission for is `forbidden` and the UI hides it. */
export type Section<T> = { status: "ok"; data: T } | { status: "unavailable" } | { status: "forbidden" };

export interface InsightsRangeDto {
  /** First local day, inclusive (`YYYY-MM-DD`). */
  from: string;
  /** Last local day, inclusive. */
  to: string;
  /** The workspace's IANA timezone the days are in. */
  tz: string;
}

export interface SupportHeadline {
  /** Distinct conversations with a customer message in range. */
  conversations: number;
  /** Conversations whose latest verdict (resolved or closed) falls in range. */
  decided: number;
  /** Decided conversations the AI resolved without staff. */
  aiResolved: number;
  /** Percent, one decimal; null when nothing was decided. */
  aiResolutionRate: number | null;
  /** Median seconds from an exchange's start to the first staff reply
   *  (AI-only exchanges excluded); null without samples. */
  medianFirstResponseSec: number | null;
  /** Exchanges in range with no reply at all. */
  unanswered: number;
  /** Median seconds from exchange start to `resolvedAt` over decided
   *  conversations; null without samples. */
  medianHandlingSec: number | null;
  timeSaved: {
    /** Customer messages in range the AI answered first. */
    customerMessages: number;
    /** customerMessages × 60 s, in hours, one decimal. */
    hours: number;
  };
  /** Percent of `conversations` with a support ticket created in range; null
   *  when there are no conversations. */
  ticketShare: number | null;
}

export interface ResolutionMix {
  ai: number;
  human: number;
  escalated: number;
  closed: number;
}

export interface Peaks {
  /** [dayOfWeek 0=Sunday … 6=Saturday][hour 0–23], workspace-local. */
  matrix: number[][];
  /** Per local hour, summed over the week. */
  byHour: number[];
}

export interface ByNumberRow {
  /** null = conversations with no channel ("Unassigned number"). */
  channelId: string | null;
  /** The number's display name; "Unassigned number" (channelId null) or
   *  "Removed number" (a channel id with no channel row). */
  label: string;
  conversations: number;
  /** Percent, one decimal; null when nothing on this number was decided. */
  aiResolutionRate: number | null;
}

export interface TopicFrictionRow {
  /** Lower-cased, trimmed. */
  topic: string;
  /** Decided conversations with this topic. */
  count: number;
  /** Percent (one decimal) of `count` in the escalated bucket. */
  escalatedShare: number;
  /** Percent (one decimal) of `count` with negative sentiment. */
  negativeShare: number;
}

export interface TeamRow {
  /** A current member's user id; null for the "Former member" and
   *  "Unattributed" rows (told apart by `former`). */
  userId: string | null;
  name: string;
  former: boolean;
  assigned: number;
  replies: number;
  medianFirstResponseSec: number | null;
  resolved: number;
}

export interface SupportInsights {
  range: InsightsRangeDto;
  channelId: string | null;
  headline: Section<SupportHeadline>;
  resolutionMix: Section<ResolutionMix>;
  peaks: Section<Peaks>;
  byNumber: Section<ByNumberRow[]>;
  topicFriction: Section<TopicFrictionRow[]>;
  team: Section<TeamRow[]>;
  /**
   * The workspace-local day (`YYYY-MM-DD`) of the first staff reply that
   * carries its sender (`Message.sentById`); earlier replies are
   * "Unattributed". null when no reply has a sender yet, or when the
   * lookup was unavailable.
   */
  attributionSince: string | null;
}

/** Task 2's shape, declared here so the contract is in one file. */
export interface SalesInsights {
  range: InsightsRangeDto;
  /** Without `tickets.view` only `id` is returned (every section is then forbidden). */
  pipeline: { id: string; name?: string; nameAr?: string; kind?: string };
  headline: Section<{ leads: number; replied: number; medianSpeedToReplySec: number | null; waiting: number; won: number }>;
  distribution: Section<{ bucket: string; count: number }[]>;
  weekly: Section<{ weekStart: string; leads: number; won: number }[]>;
  sources: Section<{ kind: string; key: string; id?: string; label: string; leads: number; won: number }[]>;
  funnel: Section<{ stageId: string; key: string; label: string; labelAr: string; reached: number; isWon: boolean; isTerminal: boolean }[]>;
  lostReasons: Section<{ reasonId: string | null; label: string; labelAr: string; count: number }[]>;
  reps: Section<
    {
      userId: string | null;
      name: string;
      former: boolean;
      leads: number;
      won: number;
      lost: number;
      medianSpeedToReplySec: number | null;
      followUps: { done: number; overdue: number; dueToday: number };
    }[]
  >;
}
