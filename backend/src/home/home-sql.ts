import { Prisma } from "@prisma/client";
import { RESOLUTION_LOOKBACK } from "../insights/insights-constants";
import { conversationScopeSql, type ConversationScope } from "../insights/insights-scope";
import { utcTimestampSql } from "../insights/support-metrics.sql";

/**
 * SP-11 working-home statements. Each starts with a `/* home:<name> *\/`
 * tag. Every conversation the home reads carries the viewer's scope inside
 * the SQL; ticket, booking and follow-up parts are gated by the member's
 * permissions (checked by the service before the statement runs, and as
 * filters here where a list mixes link kinds).
 */

const raw = Prisma.raw;
const LOOKBACK = raw(`interval '${RESOLUTION_LOOKBACK}'`);

/** At most this many rows per "needs a person" list (plus a total). */
export const HOME_LIST_CAP = 10;
/** At most this many rows per kind across today and tomorrow. */
export const HOME_DAY_CAP = 50;
/** At most this many "while you were away" conversation rows. */
export const HOME_AWAY_ROWS = 5;
/** Conversation statuses that never "need a person". */
export const NOT_WAITING_STATUSES = ["resolved", "closed", "spam", "pending_customer"] as const;

/** Today's and tomorrow's local bounds, as instants. */
export interface HomeDays {
  todayStart: Date;
  tomorrowStart: Date;
  tomorrowEnd: Date;
}

/** A follow-up's link gate: ticket-linked rows need tickets.view, the rest
 *  contacts.view (SP-04: an activity follows its link). */
export function followUpLinkSql(canTickets: boolean, canContacts: boolean, alias = "a"): Prisma.Sql {
  const a = raw(alias);
  if (canTickets && canContacts) return Prisma.empty;
  if (canTickets) return Prisma.sql`AND ${a}."ticketId" IS NOT NULL`;
  if (canContacts) return Prisma.sql`AND ${a}."ticketId" IS NULL`;
  return Prisma.sql`AND FALSE`;
}

const dayCase = (col: Prisma.Sql, d: HomeDays) =>
  Prisma.sql`CASE WHEN ${col} < ${utcTimestampSql(d.tomorrowStart)} THEN 'today' ELSE 'tomorrow' END`;

/**
 * Waiting conversations: visible, not resolved/closed/spam/pending_customer,
 * mine or unassigned, the AI off or escalated, and the latest message is the
 * customer's. `waitingSince` = the first customer message after the last
 * reply. Oldest first; `total` counts them all.
 */
export function waitingConversationsSql(ws: string, me: string, scope: ConversationScope): Prisma.Sql {
  const statuses = Prisma.join(NOT_WAITING_STATUSES.map((s) => Prisma.sql`${s}`));
  return Prisma.sql`/* home:waitingConversations */
    WITH base AS (
      SELECT c."id", c."contactId", c."channel", c."assigneeId", c."escalated",
        (SELECT MAX(n."createdAt") FROM "Message" n WHERE n."conversationId" = c."id" AND n."from" <> 'them') AS "lastReplyAt"
      FROM "Conversation" c
      WHERE c."workspaceId" = ${ws}
        AND c."status" NOT IN (${statuses})
        AND (c."aiEnabled" = FALSE OR c."escalated" = TRUE)
        AND (c."assigneeId" = ${me} OR c."assigneeId" IS NULL)
        ${conversationScopeSql(scope, "c")}
    ),
    w AS (
      SELECT b.*, (
        SELECT MIN(m."createdAt") FROM "Message" m
        WHERE m."conversationId" = b."id" AND m."from" = 'them'
          AND m."createdAt" > COALESCE(b."lastReplyAt", '-infinity'::timestamp)
      ) AS "waitingSince"
      FROM base b
    )
    SELECT w."id", ct."name" AS "contactName", w."channel", w."waitingSince", w."assigneeId", w."escalated",
      (COUNT(*) OVER ())::int AS "total"
    FROM w LEFT JOIN "Contact" ct ON ct."id" = w."contactId"
    WHERE w."waitingSince" IS NOT NULL
    ORDER BY w."waitingSince" ASC, w."id" ASC
    LIMIT ${raw(String(HOME_LIST_CAP))}`;
}

/** My open follow-ups due before today's local start. */
export function lateFollowUpsSql(ws: string, me: string, d: HomeDays, canTickets: boolean, canContacts: boolean): Prisma.Sql {
  return Prisma.sql`/* home:lateFollowUps */
    SELECT a."id", a."title", a."kind", a."dueAt", a."contactId", a."ticketId", (COUNT(*) OVER ())::int AS "total"
    FROM "Activity" a
    WHERE a."workspaceId" = ${ws} AND a."assigneeId" = ${me} AND a."doneAt" IS NULL
      AND a."dueAt" < ${utcTimestampSql(d.todayStart)}
      ${followUpLinkSql(canTickets, canContacts)}
    ORDER BY a."dueAt" ASC, a."id" ASC
    LIMIT ${raw(String(HOME_LIST_CAP))}`;
}

/** Open, unowned tickets of support pipelines: SLA due first (SP-09; nulls
 *  last), then oldest. Without SP-09 columns: oldest first, no SLA. */
export function unassignedTicketsSql(ws: string, hasSp09: boolean): Prisma.Sql {
  const sla = hasSp09 ? Prisma.sql`t."slaDueAt", t."priority"` : Prisma.sql`NULL::timestamp AS "slaDueAt", NULL::text AS "priority"`;
  const order = hasSp09 ? Prisma.sql`t."slaDueAt" ASC NULLS LAST, t."createdAt" ASC, t."id" ASC` : Prisma.sql`t."createdAt" ASC, t."id" ASC`;
  return Prisma.sql`/* home:unassignedTickets */
    SELECT t."id", t."number", t."title", t."createdAt", ct."name" AS "contactName", ${sla}, (COUNT(*) OVER ())::int AS "total"
    FROM "Ticket" t
    JOIN "Pipeline" p ON p."id" = t."pipelineId"
    JOIN "TicketStage" st ON st."id" = t."stageId"
    LEFT JOIN "Contact" ct ON ct."id" = t."contactId"
    WHERE t."workspaceId" = ${ws} AND p."kind" = 'support'
      AND t."ownerId" IS NULL AND t."closedAt" IS NULL AND NOT st."isTerminal"
    ORDER BY ${order}
    LIMIT ${raw(String(HOME_LIST_CAP))}`;
}

/** My open follow-ups due today or tomorrow (local days). */
export function dayFollowUpsSql(ws: string, me: string, d: HomeDays, canTickets: boolean, canContacts: boolean): Prisma.Sql {
  return Prisma.sql`/* home:dayFollowUps */
    SELECT ${dayCase(Prisma.sql`a."dueAt"`, d)} AS "day",
      a."id", a."title", a."kind", a."dueAt", a."contactId", a."ticketId"
    FROM "Activity" a
    WHERE a."workspaceId" = ${ws} AND a."assigneeId" = ${me} AND a."doneAt" IS NULL
      AND a."dueAt" >= ${utcTimestampSql(d.todayStart)} AND a."dueAt" < ${utcTimestampSql(d.tomorrowEnd)}
      ${followUpLinkSql(canTickets, canContacts)}
    ORDER BY a."dueAt" ASC, a."id" ASC
    LIMIT ${raw(String(HOME_DAY_CAP * 2))}`;
}

/**
 * Pending/confirmed bookings today or tomorrow: mine (my StaffResource or
 * staffId) when I have any, else all. Without SP-10's StaffResource:
 * bookings with staffId = me only (ruling 11).
 */
export function dayBookingsSql(ws: string, me: string, d: HomeDays, hasSp10: boolean): Prisma.Sql {
  const mine = hasSp10
    ? Prisma.sql`AND (
        NOT (
          EXISTS (SELECT 1 FROM "StaffResource" r WHERE r."workspaceId" = ${ws} AND r."userId" = ${me})
          OR EXISTS (SELECT 1 FROM "Appointment" x WHERE x."workspaceId" = ${ws} AND x."staffId" = ${me})
        )
        OR b."staffId" = ${me}
        OR b."resourceId" IN (SELECT r."id" FROM "StaffResource" r WHERE r."workspaceId" = ${ws} AND r."userId" = ${me})
      )`
    : Prisma.sql`AND b."staffId" = ${me}`;
  return Prisma.sql`/* home:dayBookings */
    SELECT ${dayCase(Prisma.sql`b."startAt"`, d)} AS "day",
      b."id", b."startAt", b."durationMin", b."service", b."serviceAr", b."status", ct."name" AS "contactName"
    FROM "Appointment" b LEFT JOIN "Contact" ct ON ct."id" = b."contactId"
    WHERE b."workspaceId" = ${ws} AND b."status" IN ('pending', 'confirmed')
      AND b."startAt" >= ${utcTimestampSql(d.todayStart)} AND b."startAt" < ${utcTimestampSql(d.tomorrowEnd)}
      ${mine}
    ORDER BY b."startAt" ASC, b."id" ASC
    LIMIT ${raw(String(HOME_DAY_CAP * 2))}`;
}

/** My open tickets whose SLA falls today or tomorrow (SP-09 only). */
export function dayTicketsDueSql(ws: string, me: string, d: HomeDays): Prisma.Sql {
  return Prisma.sql`/* home:dayTicketsDue */
    SELECT ${dayCase(Prisma.sql`t."slaDueAt"`, d)} AS "day",
      t."id", t."number", t."title", t."createdAt", t."slaDueAt", t."priority", ct."name" AS "contactName"
    FROM "Ticket" t JOIN "TicketStage" st ON st."id" = t."stageId" LEFT JOIN "Contact" ct ON ct."id" = t."contactId"
    WHERE t."workspaceId" = ${ws} AND t."ownerId" = ${me} AND t."closedAt" IS NULL AND NOT st."isTerminal"
      AND t."slaDueAt" >= ${utcTimestampSql(d.todayStart)} AND t."slaDueAt" < ${utcTimestampSql(d.tomorrowEnd)}
    ORDER BY t."slaDueAt" ASC, t."id" ASC
    LIMIT ${raw(String(HOME_DAY_CAP * 2))}`;
}

/** The support "AI resolved" definition on alias c (insights ruling 3). */
function aiResolvedSql(): Prisma.Sql {
  return Prisma.sql`c."resolutionStatus" = 'resolved' AND NOT c."escalated"
    AND COALESCE(c."resolutionIssue", '') NOT IN ('complaint', 'escalation')
    AND NOT EXISTS (
      SELECT 1 FROM "Message" h
      WHERE h."conversationId" = c."id" AND h."from" = 'human'
        AND h."createdAt" > c."resolvedAt" - ${LOOKBACK} AND h."createdAt" <= c."resolvedAt"
    )`;
}

export interface AwayFlags {
  conversations: boolean;
  bookings: boolean;
  tickets: boolean;
}

/**
 * "While you were away", in (since, now]: AI replies and AI-resolved
 * conversations under the viewer's scope, self-booked appointments,
 * automation-created tickets; plus the newest AI-resolved conversations.
 * A kind the member may not see is NULL (and no rows).
 */
export function awaySql(ws: string, since: Date, now: Date, scope: ConversationScope, f: AwayFlags): Prisma.Sql {
  const s = utcTimestampSql(since);
  const n = utcTimestampSql(now);
  const resolved = Prisma.sql`FROM "Conversation" c
    WHERE c."workspaceId" = ${ws} AND c."resolvedAt" > ${s} AND c."resolvedAt" <= ${n}
      AND ${aiResolvedSql()}
      ${conversationScopeSql(scope, "c")}`;
  const nul = Prisma.sql`NULL::int`;
  return Prisma.sql`/* home:away */
    SELECT
      ${
        f.conversations
          ? Prisma.sql`(SELECT COUNT(*) FROM "Message" m JOIN "Conversation" c ON c."id" = m."conversationId"
              WHERE m."workspaceId" = ${ws} AND c."workspaceId" = ${ws} AND m."from" = 'ai'
                AND m."createdAt" > ${s} AND m."createdAt" <= ${n}
                ${conversationScopeSql(scope, "c")})::int`
          : nul
      } AS "aiReplies",
      ${f.conversations ? Prisma.sql`(SELECT COUNT(*) ${resolved})::int` : nul} AS "aiResolved",
      ${
        f.bookings
          ? Prisma.sql`(SELECT COUNT(*) FROM "Appointment" b
              WHERE b."workspaceId" = ${ws} AND b."source" = 'self-booking'
                AND b."createdAt" > ${s} AND b."createdAt" <= ${n})::int`
          : nul
      } AS "agentBookings",
      ${
        f.tickets
          ? Prisma.sql`(SELECT COUNT(*) FROM "TicketActivity" ta
              WHERE ta."workspaceId" = ${ws} AND ta."kind" = 'created' AND ta."byUserId" IS NULL
                AND ta."createdAt" > ${s} AND ta."createdAt" <= ${n})::int`
          : nul
      } AS "autoTickets",
      ${
        f.conversations
          ? Prisma.sql`(SELECT COALESCE(json_agg(r ORDER BY r."resolvedAt" DESC, r."id" DESC), '[]'::json) FROM (
              SELECT c."id", (SELECT ct."name" FROM "Contact" ct WHERE ct."id" = c."contactId") AS "contactName", c."resolvedAt"
              ${resolved}
              ORDER BY c."resolvedAt" DESC, c."id" DESC
              LIMIT ${raw(String(HOME_AWAY_ROWS))}
            ) r)`
          : Prisma.sql`'[]'::json`
      } AS "rows"`;
}

/** Which Day-1 steps are done (from data). */
export function day1Sql(ws: string, hasSp10: boolean): Prisma.Sql {
  return Prisma.sql`/* home:day1 */
    SELECT
      EXISTS (SELECT 1 FROM "Channel" ch WHERE ch."workspaceId" = ${ws} AND ch."status" = 'active') AS "connect_channel",
      EXISTS (SELECT 1 FROM "Media" md WHERE md."workspaceId" = ${ws} AND md."approvedForAgent" = TRUE) AS "add_knowledge",
      (SELECT COUNT(*) FROM "WorkspaceMember" wm WHERE wm."workspaceId" = ${ws}) > 1 AS "invite_team",
      EXISTS (SELECT 1 FROM "Pipeline" p WHERE p."workspaceId" = ${ws} AND (p."isDefault" = FALSE OR p."version" > 0)) AS "set_pipeline",
      ${hasSp10 ? Prisma.sql`EXISTS (SELECT 1 FROM "Service" sv WHERE sv."workspaceId" = ${ws})` : Prisma.sql`FALSE`} AS "add_services",
      EXISTS (SELECT 1 FROM "Message" hm WHERE hm."workspaceId" = ${ws} AND hm."from" = 'human') AS "first_reply"`;
}

/** Ruling 11: do SP-09's and SP-10's columns exist in this database? */
export function schemaCheckSql(): Prisma.Sql {
  return Prisma.sql`/* home:schema */
    SELECT table_name AS "table", column_name AS "column" FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND ((table_name = 'Ticket' AND column_name = 'slaDueAt')
        OR (table_name = 'Appointment' AND column_name = 'resourceId')
        OR (table_name = 'StaffResource' AND column_name = 'userId')
        OR (table_name = 'Service' AND column_name = 'id'))`;
}
