import { Prisma } from "@prisma/client";
import { RESOLUTION_LOOKBACK, TOP_TOPICS, TOPIC_MIN_CONVERSATIONS } from "./insights-constants";
import type { InsightsRange } from "./insights-range";
import { localTimeSql } from "./insights-range";
import { conversationScopeSql, type ConversationScope } from "./insights-scope";
import { FORMER_KEY, UNATTRIBUTED_KEY } from "./insights-format";

/**
 * SP-11 support metrics, one SQL builder per metric (the plan's metric table).
 * Every builder takes `(ws, range, scope, opts)`:
 *  - the range is `[fromUtc, toUtcExclusive)` (workspace-local days);
 *  - `scope` is the viewer's conversation scope, applied INSIDE the SQL on
 *    every conversation the metric reads (Review Focus 1);
 *  - `opts.channelId` narrows every metric to one number.
 * Each statement starts with a `/* insights:support.<metric> *\/` tag.
 *
 * Message facts relied on: `from` is them | ai | human; messages are ordered
 * by (`createdAt`, `id`); an exchange starts at a customer message whose
 * previous message in the conversation is not a customer message (or none).
 */

export interface SupportOpts {
  channelId: string | null;
}

const raw = Prisma.raw;
const LOOKBACK = raw(`interval '${RESOLUTION_LOOKBACK}'`);

/** `AND c."channelId" = $id` when filtering by number. */
function channelSql(opts: SupportOpts, alias = "c"): Prisma.Sql {
  return opts.channelId ? Prisma.sql`AND ${raw(alias)}."channelId" = ${opts.channelId}` : Prisma.empty;
}

/**
 * An instant as a UTC `timestamp` (Prisma's `DateTime` columns are
 * `timestamp(3)` holding UTC). Bound as ISO text and converted in SQL, so the
 * comparison never depends on the session's TimeZone setting.
 */
export function utcTimestampSql(d: Date): Prisma.Sql {
  return Prisma.sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}

/** `col` within the range. */
export function inRangeSql(col: Prisma.Sql, r: InsightsRange): Prisma.Sql {
  return Prisma.sql`${col} >= ${utcTimestampSql(r.fromUtc)} AND ${col} < ${utcTimestampSql(r.toUtcExclusive)}`;
}

/** Message `alias` starts an exchange: a customer message whose previous
 *  message in the conversation is not a customer message (or there is none). */
function exchangeStartSql(alias: string): Prisma.Sql {
  const a = raw(alias);
  return Prisma.sql`${a}."from" = 'them' AND COALESCE((
      SELECT p."from" FROM "Message" p
      WHERE p."conversationId" = ${a}."conversationId"
        AND (p."createdAt", p."id") < (${a}."createdAt", ${a}."id")
      ORDER BY p."createdAt" DESC, p."id" DESC
      LIMIT 1
    ), '') <> 'them'`;
}

/** Customer messages in range on visible conversations (alias m, c). */
function customerMessagesFrom(ws: string, r: InsightsRange, scope: ConversationScope, opts: SupportOpts): Prisma.Sql {
  return Prisma.sql`FROM "Message" m
    JOIN "Conversation" c ON c."id" = m."conversationId"
    WHERE m."workspaceId" = ${ws} AND c."workspaceId" = ${ws}
      AND m."from" = 'them'
      AND ${inRangeSql(Prisma.sql`m."createdAt"`, r)}
      ${conversationScopeSql(scope, "c")}
      ${channelSql(opts)}`;
}

/** CTE body: the range's conversations (a customer message in range). */
function rangeConversationsCte(ws: string, r: InsightsRange, scope: ConversationScope, opts: SupportOpts): Prisma.Sql {
  return Prisma.sql`SELECT DISTINCT c."id", c."channelId", c."channel", c."assigneeId"
    ${customerMessagesFrom(ws, r, scope, opts)}`;
}

/**
 * CTE body: decided conversations (latest verdict resolved/closed with
 * `resolvedAt` in range) and their disjoint bucket, first match wins:
 * closed → escalated (flag, complaint or escalation issue) → ai (no staff
 * message in the lookback before `resolvedAt`) → human.
 */
function decidedCte(ws: string, r: InsightsRange, scope: ConversationScope, opts: SupportOpts): Prisma.Sql {
  return Prisma.sql`SELECT c."id", c."channelId", c."channel", c."assigneeId", c."resolvedAt",
      c."resolutionSentiment", c."topics",
      CASE
        WHEN c."resolutionStatus" = 'closed' THEN 'closed'
        WHEN c."escalated" OR COALESCE(c."resolutionIssue", '') IN ('complaint', 'escalation') THEN 'escalated'
        WHEN NOT EXISTS (
          SELECT 1 FROM "Message" h
          WHERE h."conversationId" = c."id" AND h."from" = 'human'
            AND h."createdAt" > c."resolvedAt" - ${LOOKBACK}
            AND h."createdAt" <= c."resolvedAt"
        ) THEN 'ai'
        ELSE 'human'
      END AS "bucket"
    FROM "Conversation" c
    WHERE c."workspaceId" = ${ws}
      AND c."resolutionStatus" IN ('resolved', 'closed')
      AND ${inRangeSql(Prisma.sql`c."resolvedAt"`, r)}
      ${conversationScopeSql(scope, "c")}
      ${channelSql(opts)}`;
}

/**
 * CTE body: every exchange starting in range with its first reply (`replyFrom`,
 * null = unanswered) and its first staff message before the next exchange
 * starts (`humanAt`, `humanBy` = that message's `sentById`).
 */
function exchangesCte(ws: string, r: InsightsRange, scope: ConversationScope, opts: SupportOpts): Prisma.Sql {
  return Prisma.sql`SELECT e."id", e."conversationId", e."createdAt" AS "startAt",
      rr."from" AS "replyFrom", hh."createdAt" AS "humanAt", hh."sentById" AS "humanBy"
    FROM "Message" e
    JOIN "Conversation" c ON c."id" = e."conversationId"
    LEFT JOIN LATERAL (
      SELECT n."id", n."from", n."createdAt" FROM "Message" n
      WHERE n."conversationId" = e."conversationId" AND n."from" <> 'them'
        AND (n."createdAt", n."id") > (e."createdAt", e."id")
      ORDER BY n."createdAt", n."id"
      LIMIT 1
    ) rr ON TRUE
    LEFT JOIN LATERAL (
      SELECT n."id", n."createdAt" FROM "Message" n
      WHERE rr."id" IS NOT NULL AND n."conversationId" = e."conversationId" AND n."from" = 'them'
        AND (n."createdAt", n."id") > (rr."createdAt", rr."id")
      ORDER BY n."createdAt", n."id"
      LIMIT 1
    ) nx ON TRUE
    LEFT JOIN LATERAL (
      SELECT n."createdAt", n."sentById" FROM "Message" n
      WHERE n."conversationId" = e."conversationId" AND n."from" = 'human'
        AND (n."createdAt", n."id") > (e."createdAt", e."id")
        AND (nx."id" IS NULL OR (n."createdAt", n."id") < (nx."createdAt", nx."id"))
      ORDER BY n."createdAt", n."id"
      LIMIT 1
    ) hh ON TRUE
    WHERE e."workspaceId" = ${ws} AND c."workspaceId" = ${ws}
      AND ${inRangeSql(Prisma.sql`e."createdAt"`, r)}
      AND ${exchangeStartSql("e")}
      ${conversationScopeSql(scope, "c")}
      ${channelSql(opts)}`;
}

/** Median of an interval expression in seconds (percentile_cont). */
function medianSecondsSql(interval: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (${interval}))::float8)`;
}

/** Team key: a current member's id, else "~former"; a null id is
 *  "~unattributed". */
function teamKeySql(ws: string, col: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`CASE
      WHEN ${col} IS NULL THEN ${UNATTRIBUTED_KEY}
      WHEN EXISTS (SELECT 1 FROM "WorkspaceMember" wm WHERE wm."workspaceId" = ${ws} AND wm."userId" = ${col}) THEN ${col}
      ELSE ${FORMER_KEY}
    END`;
}

// ── One builder per metric ───────────────────────────────────────────────

/** `conversations`: distinct conversations with a customer message in range.
 *  Row: `{ conversations }`. */
export function conversationsSql(ws: string, r: InsightsRange, scope: ConversationScope, opts: SupportOpts): Prisma.Sql {
  return Prisma.sql`/* insights:support.conversations */
    SELECT COUNT(DISTINCT m."conversationId")::int AS "conversations"
    ${customerMessagesFrom(ws, r, scope, opts)}`;
}

/** `decided`, `aiResolved` (→ `aiResolutionRate`). Row: `{ decided, aiResolved }`. */
export function aiResolutionSql(ws: string, r: InsightsRange, scope: ConversationScope, opts: SupportOpts): Prisma.Sql {
  return Prisma.sql`/* insights:support.aiResolution */
    WITH d AS (${decidedCte(ws, r, scope, opts)})
    SELECT COUNT(*)::int AS "decided", (COUNT(*) FILTER (WHERE d."bucket" = 'ai'))::int AS "aiResolved"
    FROM d`;
}

/** `medianFirstResponseSec`, `unanswered`: AI-only exchanges (AI replied, no
 *  staff before the next exchange) are excluded. Row: `{ median, unanswered }`. */
export function firstResponseSql(ws: string, r: InsightsRange, scope: ConversationScope, opts: SupportOpts): Prisma.Sql {
  return Prisma.sql`/* insights:support.firstResponse */
    WITH x AS (${exchangesCte(ws, r, scope, opts)})
    SELECT (${medianSecondsSql(Prisma.sql`x."humanAt" - x."startAt"`)} FILTER (WHERE x."humanAt" IS NOT NULL))::float8 AS "median",
      (COUNT(*) FILTER (WHERE x."replyFrom" IS NULL))::int AS "unanswered"
    FROM x`;
}

/** `medianHandlingSec`: per decided conversation, `resolvedAt` − the start of
 *  its earliest exchange inside the lookback window. Row: `{ median }`. */
export function handlingSql(ws: string, r: InsightsRange, scope: ConversationScope, opts: SupportOpts): Prisma.Sql {
  return Prisma.sql`/* insights:support.handling */
    WITH d AS (${decidedCte(ws, r, scope, opts)}),
    hs AS (
      SELECT d."resolvedAt" - (
        SELECT MIN(e."createdAt") FROM "Message" e
        WHERE e."conversationId" = d."id"
          AND e."createdAt" > d."resolvedAt" - ${LOOKBACK}
          AND e."createdAt" <= d."resolvedAt"
          AND ${exchangeStartSql("e")}
      ) AS "dur"
      FROM d
    )
    SELECT (${medianSecondsSql(Prisma.sql`hs."dur"`)} FILTER (WHERE hs."dur" IS NOT NULL))::float8 AS "median"
    FROM hs`;
}

/** `timeSaved.customerMessages`: customer messages in range whose next
 *  non-customer message is the AI's. Row: `{ customerMessages }`. */
export function timeSavedSql(ws: string, r: InsightsRange, scope: ConversationScope, opts: SupportOpts): Prisma.Sql {
  return Prisma.sql`/* insights:support.timeSaved */
    SELECT COUNT(*)::int AS "customerMessages"
    ${customerMessagesFrom(ws, r, scope, opts)}
      AND (
        SELECT n."from" FROM "Message" n
        WHERE n."conversationId" = m."conversationId" AND n."from" <> 'them'
          AND (n."createdAt", n."id") > (m."createdAt", m."id")
        ORDER BY n."createdAt", n."id"
        LIMIT 1
      ) = 'ai'`;
}

/** `ticketShare`: range conversations with a support-pipeline ticket created
 *  in range. Row: `{ conversations, ticketed }`. */
export function ticketShareSql(ws: string, r: InsightsRange, scope: ConversationScope, opts: SupportOpts): Prisma.Sql {
  return Prisma.sql`/* insights:support.ticketShare */
    WITH cs AS (${rangeConversationsCte(ws, r, scope, opts)})
    SELECT COUNT(*)::int AS "conversations",
      (COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM "Ticket" t JOIN "Pipeline" p ON p."id" = t."pipelineId"
        WHERE t."workspaceId" = ${ws} AND t."conversationId" = cs."id"
          AND p."kind" = 'support'
          AND ${inRangeSql(Prisma.sql`t."createdAt"`, r)}
      )))::int AS "ticketed"
    FROM cs`;
}

/** `resolutionMix`: decided conversations per bucket. Rows: `{ bucket, n }`. */
export function resolutionMixSql(ws: string, r: InsightsRange, scope: ConversationScope, opts: SupportOpts): Prisma.Sql {
  return Prisma.sql`/* insights:support.resolutionMix */
    WITH d AS (${decidedCte(ws, r, scope, opts)})
    SELECT d."bucket", COUNT(*)::int AS "n" FROM d GROUP BY d."bucket"`;
}

/** `peaks`: customer messages in range by workspace-local day of week
 *  (0 = Sunday) and hour. Rows: `{ dow, hour, n }`. */
export function peaksSql(ws: string, r: InsightsRange, scope: ConversationScope, opts: SupportOpts): Prisma.Sql {
  const local = localTimeSql(Prisma.sql`m."createdAt"`, r.tz);
  return Prisma.sql`/* insights:support.peaks */
    SELECT EXTRACT(DOW FROM ${local})::int AS "dow", EXTRACT(HOUR FROM ${local})::int AS "hour", COUNT(*)::int AS "n"
    ${customerMessagesFrom(ws, r, scope, opts)}
    GROUP BY 1, 2`;
}

/** `byNumber`: range conversations and decided/ai counts per WhatsApp number
 *  (channel kind, else the conversation's channel string, is whatsapp).
 *  Rows: `{ channelId, label, exists, conversations, decided, ai }`. */
export function byNumberSql(ws: string, r: InsightsRange, scope: ConversationScope, opts: SupportOpts): Prisma.Sql {
  return Prisma.sql`/* insights:support.byNumber */
    WITH cs AS (${rangeConversationsCte(ws, r, scope, opts)}),
    d AS (${decidedCte(ws, r, scope, opts)}),
    k AS (
      SELECT cs."channelId", COUNT(*)::int AS "conversations", 0 AS "decided", 0 AS "ai"
      FROM cs LEFT JOIN "Channel" chn ON chn."id" = cs."channelId" AND chn."workspaceId" = ${ws}
      WHERE lower(COALESCE(chn."kind", cs."channel")) = 'whatsapp'
      GROUP BY cs."channelId"
      UNION ALL
      SELECT d."channelId", 0, COUNT(*)::int, (COUNT(*) FILTER (WHERE d."bucket" = 'ai'))::int
      FROM d LEFT JOIN "Channel" chn ON chn."id" = d."channelId" AND chn."workspaceId" = ${ws}
      WHERE lower(COALESCE(chn."kind", d."channel")) = 'whatsapp'
      GROUP BY d."channelId"
    )
    SELECT k."channelId", chn."displayName" AS "label", (chn."id" IS NOT NULL) AS "exists",
      SUM(k."conversations")::int AS "conversations", SUM(k."decided")::int AS "decided", SUM(k."ai")::int AS "ai"
    FROM k LEFT JOIN "Channel" chn ON chn."id" = k."channelId" AND chn."workspaceId" = ${ws}
    GROUP BY k."channelId", chn."displayName", chn."id"`;
}

/** `topicFriction`: decided conversations per topic (lower-cased, trimmed,
 *  once per conversation), with the escalated and negative counts; topics
 *  from at least TOPIC_MIN_CONVERSATIONS conversations, top TOP_TOPICS.
 *  Rows: `{ topic, count, escalated, negative }`. */
export function topicFrictionSql(ws: string, r: InsightsRange, scope: ConversationScope, opts: SupportOpts): Prisma.Sql {
  return Prisma.sql`/* insights:support.topicFriction */
    WITH d AS (${decidedCte(ws, r, scope, opts)}),
    t AS (
      SELECT DISTINCT d."id", lower(btrim(x."topic")) AS "topic", d."bucket", d."resolutionSentiment" AS "sentiment"
      FROM d
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(d."topics") = 'array' THEN d."topics" ELSE '[]'::jsonb END
      ) AS x("topic")
    )
    SELECT t."topic", COUNT(*)::int AS "count",
      (COUNT(*) FILTER (WHERE t."bucket" = 'escalated'))::int AS "escalated",
      (COUNT(*) FILTER (WHERE t."sentiment" = 'negative'))::int AS "negative"
    FROM t
    WHERE t."topic" <> ''
    GROUP BY t."topic"
    HAVING COUNT(*) >= ${raw(String(Math.trunc(TOPIC_MIN_CONVERSATIONS)))}
    ORDER BY COUNT(*) DESC, t."topic" ASC
    LIMIT ${raw(String(Math.trunc(TOP_TOPICS)))}`;
}

/**
 * `team[]` totals per key (a current member's user id, "~former" or
 * "~unattributed"): `assigned` (range conversations by assignee), `replies`
 * (staff messages in range by `sentById`), `median` (first response by the
 * replying sender), `resolved` (decided, human bucket, by assignee).
 * Rows: `{ key, assigned, replies, resolved, median }`.
 */
export function teamSql(ws: string, r: InsightsRange, scope: ConversationScope, opts: SupportOpts): Prisma.Sql {
  return Prisma.sql`/* insights:support.team */
    WITH cs AS (${rangeConversationsCte(ws, r, scope, opts)}),
    d AS (${decidedCte(ws, r, scope, opts)}),
    x AS (${exchangesCte(ws, r, scope, opts)}),
    src AS (
      SELECT cs."assigneeId" AS "uid", 1 AS "assigned", 0 AS "replies", 0 AS "resolved"
      FROM cs WHERE cs."assigneeId" IS NOT NULL
      UNION ALL
      SELECT m."sentById", 0, 1, 0
      FROM "Message" m JOIN "Conversation" c ON c."id" = m."conversationId"
      WHERE m."workspaceId" = ${ws} AND c."workspaceId" = ${ws}
        AND m."from" = 'human'
        AND ${inRangeSql(Prisma.sql`m."createdAt"`, r)}
        ${conversationScopeSql(scope, "c")}
        ${channelSql(opts)}
      UNION ALL
      SELECT d."assigneeId", 0, 0, 1 FROM d WHERE d."bucket" = 'human' AND d."assigneeId" IS NOT NULL
    ),
    tot AS (
      SELECT ${teamKeySql(ws, Prisma.sql`src."uid"`)} AS "key",
        SUM(src."assigned")::int AS "assigned", SUM(src."replies")::int AS "replies", SUM(src."resolved")::int AS "resolved"
      FROM src GROUP BY 1
    ),
    fr AS (
      SELECT ${teamKeySql(ws, Prisma.sql`x."humanBy"`)} AS "key",
        ${medianSecondsSql(Prisma.sql`x."humanAt" - x."startAt"`)} AS "median"
      FROM x WHERE x."humanAt" IS NOT NULL GROUP BY 1
    )
    SELECT COALESCE(tot."key", fr."key") AS "key",
      COALESCE(tot."assigned", 0)::int AS "assigned", COALESCE(tot."replies", 0)::int AS "replies",
      COALESCE(tot."resolved", 0)::int AS "resolved", fr."median"::float8 AS "median"
    FROM tot FULL OUTER JOIN fr ON fr."key" = tot."key"`;
}

/** The workspace's current members and their names (team rows). */
export function teamMembersSql(ws: string): Prisma.Sql {
  return Prisma.sql`/* insights:support.teamMembers */
    SELECT wm."userId", u."name" FROM "WorkspaceMember" wm JOIN "User" u ON u."id" = wm."userId"
    WHERE wm."workspaceId" = ${ws}`;
}
