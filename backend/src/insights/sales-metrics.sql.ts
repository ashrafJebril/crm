import { Prisma } from "@prisma/client";
import { SPEED_BUCKETS, SPEED_BUCKET_KEYS, WAITING_EXCLUDED_STATUSES } from "./insights-constants";
import { FORMER_KEY } from "./insights-format";
import { localWeekStartSql, type InsightsRange } from "./insights-range";
import { conversationScopeSql, type ConversationScope } from "./insights-scope";
import { inRangeSql, medianSecondsSql, utcTimestampSql } from "./support-metrics.sql";

/**
 * SP-11 sales metrics, one SQL builder per metric (the plan's sales table).
 * Every builder takes `(ws, range, scope, opts)`; `opts.pipelineId` is the
 * resolved pipeline P. A lead is a Ticket of P. Ticket figures are not
 * conversation-scoped (they need `tickets.view`, checked by the service);
 * every conversation- or message-derived part (replied, speed, waiting, the
 * ad and channel of a source, a rep's speed) reads only conversations the
 * viewer may see, inside the SQL (Review Focus 1).
 * Each statement starts with a `/* insights:sales.<metric> *\/` tag.
 */

export interface SalesOpts {
  pipelineId: string;
  /** The request's one anchor (waiting and follow-ups are "now", not range). */
  now: Date;
  /** End of today (local), as an instant (follow-ups due today). */
  todayEnd: Date;
  /** Workspace language: Sunday weeks for "ar", Monday otherwise (ruling 10). */
  lang: string | null;
}

const raw = Prisma.raw;

/** Unassigned tickets / follow-ups group under this key in the reps table. */
export const UNASSIGNED_KEY = "~unassigned";

/** CTE body: the range's leads (tickets of P created in range). */
function leadsCte(ws: string, r: InsightsRange, opts: SalesOpts): Prisma.Sql {
  return Prisma.sql`SELECT t."id", t."contactId", t."createdAt", t."ownerId", t."stageId"
    FROM "Ticket" t
    WHERE t."workspaceId" = ${ws} AND t."pipelineId" = ${opts.pipelineId}
      AND ${inRangeSql(Prisma.sql`t."createdAt"`, r)}`;
}

/** Messages of the lead's contact on conversations the viewer may see
 *  (alias m, c; `lead` is the outer lead alias). */
function contactMessagesFrom(ws: string, scope: ConversationScope, lead: string): Prisma.Sql {
  return Prisma.sql`FROM "Message" m
    JOIN "Conversation" c ON c."id" = m."conversationId"
    WHERE c."workspaceId" = ${ws} AND c."contactId" = ${raw(lead)}."contactId"
      ${conversationScopeSql(scope, "c")}`;
}

/** The first staff message after the lead was created (optionally sent by
 *  `sentBy`), on visible conversations of its contact. */
function firstStaffReplySql(ws: string, scope: ConversationScope, lead: string, sentBy?: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(SELECT MIN(m."createdAt")
    ${contactMessagesFrom(ws, scope, lead)}
      AND m."from" = 'human' AND m."createdAt" > ${raw(lead)}."createdAt"
      ${sentBy ? Prisma.sql`AND m."sentById" = ${sentBy}` : Prisma.empty})`;
}

/** CTE body: each lead with `sec` = seconds to its first staff reply (null:
 *  none; AI replies never count, ruling 5). */
function speedCte(ws: string, r: InsightsRange, scope: ConversationScope, opts: SalesOpts): Prisma.Sql {
  return Prisma.sql`SELECT l."id", EXTRACT(EPOCH FROM (${firstStaffReplySql(ws, scope, "l")} - l."createdAt"))::float8 AS "sec"
    FROM (${leadsCte(ws, r, opts)}) l`;
}

/** Bucket key of the seconds column `col` (edges go to the higher bucket).
 *  Built from code constants only. */
function bucketCaseSql(col: string): Prisma.Sql {
  const whens = SPEED_BUCKETS.map((min, i) => `WHEN ${col} < ${min * 60} THEN '${SPEED_BUCKET_KEYS[i]}'`).join(" ");
  const over = SPEED_BUCKET_KEYS[SPEED_BUCKETS.length];
  return raw(`CASE WHEN ${col} IS NULL THEN 'not_replied' ${whens} ELSE '${over}' END`);
}

/** Key of a member column: a current member's id, "~former" for anyone else,
 *  "~unassigned" for null. */
function memberKeySql(ws: string, col: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`CASE
      WHEN ${col} IS NULL THEN ${UNASSIGNED_KEY}
      WHEN EXISTS (SELECT 1 FROM "WorkspaceMember" wm WHERE wm."workspaceId" = ${ws} AND wm."userId" = ${col}) THEN ${col}
      ELSE ${FORMER_KEY}
    END`;
}

/** Moves (won/lost activities) in range on tickets of P. */
function movesFrom(ws: string, r: InsightsRange, opts: SalesOpts, kind: "won" | "lost"): Prisma.Sql {
  return Prisma.sql`FROM "TicketActivity" a
    JOIN "Ticket" t ON t."id" = a."ticketId"
    WHERE a."workspaceId" = ${ws} AND t."workspaceId" = ${ws} AND t."pipelineId" = ${opts.pipelineId}
      AND a."kind" = ${kind}
      AND ${inRangeSql(Prisma.sql`a."createdAt"`, r)}`;
}

// ── One builder per metric ───────────────────────────────────────────────

/** `leads`: tickets of P created in range. Row `{ leads }`. */
export function leadsSql(ws: string, r: InsightsRange, _scope: ConversationScope, opts: SalesOpts): Prisma.Sql {
  return Prisma.sql`/* insights:sales.leads */
    SELECT COUNT(*)::int AS "leads" FROM (${leadsCte(ws, r, opts)}) l`;
}

/** `replied`: leads with an AI or staff message, after creation, on a visible
 *  conversation of the contact. Row `{ replied }`. */
export function repliedSql(ws: string, r: InsightsRange, scope: ConversationScope, opts: SalesOpts): Prisma.Sql {
  return Prisma.sql`/* insights:sales.replied */
    SELECT COUNT(*)::int AS "replied" FROM (${leadsCte(ws, r, opts)}) l
    WHERE EXISTS (
      SELECT 1 ${contactMessagesFrom(ws, scope, "l")}
        AND m."from" IN ('ai', 'human') AND m."createdAt" > l."createdAt"
    )`;
}

/** `speedToReply.median`: median seconds to the first staff reply over leads
 *  that have one. Row `{ median }`. */
export function speedToReplySql(ws: string, r: InsightsRange, scope: ConversationScope, opts: SalesOpts): Prisma.Sql {
  return Prisma.sql`/* insights:sales.speedToReply */
    WITH s AS (${speedCte(ws, r, scope, opts)})
    SELECT (${medianSecondsSql(Prisma.sql`s."sec" * interval '1 second'`)} FILTER (WHERE s."sec" IS NOT NULL))::float8 AS "median"
    FROM s`;
}

/** `speedToReply.distribution`: leads per bucket. Rows `{ bucket, n }`. */
export function speedDistributionSql(ws: string, r: InsightsRange, scope: ConversationScope, opts: SalesOpts): Prisma.Sql {
  return Prisma.sql`/* insights:sales.speedDistribution */
    WITH s AS (${speedCte(ws, r, scope, opts)})
    SELECT ${bucketCaseSql(`s."sec"`)} AS "bucket", COUNT(*)::int AS "n"
    FROM s GROUP BY 1`;
}

/** `waiting` (now, not range): open leads of P (stage not terminal, not
 *  closed) whose contact's latest message, over visible conversations not
 *  resolved/closed/spam, is the customer's. Row `{ waiting }`. */
export function waitingSql(ws: string, _r: InsightsRange, scope: ConversationScope, opts: SalesOpts): Prisma.Sql {
  const excluded = Prisma.join(WAITING_EXCLUDED_STATUSES.map((s) => Prisma.sql`${s}`));
  return Prisma.sql`/* insights:sales.waiting */
    SELECT COUNT(*)::int AS "waiting"
    FROM "Ticket" t JOIN "TicketStage" st ON st."id" = t."stageId"
    WHERE t."workspaceId" = ${ws} AND t."pipelineId" = ${opts.pipelineId}
      AND t."closedAt" IS NULL AND NOT st."isTerminal"
      AND (
        SELECT m."from" ${contactMessagesFrom(ws, scope, "t")}
          AND c."status" NOT IN (${excluded})
          AND m."createdAt" <= ${utcTimestampSql(opts.now)}
        ORDER BY m."createdAt" DESC, m."id" DESC
        LIMIT 1
      ) = 'them'`;
}

/** `won`: distinct tickets of P with a won move in range. Row `{ won }`. */
export function wonSql(ws: string, r: InsightsRange, _scope: ConversationScope, opts: SalesOpts): Prisma.Sql {
  return Prisma.sql`/* insights:sales.won */
    SELECT COUNT(DISTINCT a."ticketId")::int AS "won" ${movesFrom(ws, r, opts, "won")}`;
}

/** `weekly[]`: leads (by creation) and distinct won tickets (by won move)
 *  per workspace-local week. Rows `{ week: 'YYYY-MM-DD', leads, won }`;
 *  empty weeks are filled by the service. */
export function weeklySql(ws: string, r: InsightsRange, _scope: ConversationScope, opts: SalesOpts): Prisma.Sql {
  return Prisma.sql`/* insights:sales.weekly */
    WITH k AS (
      SELECT ${localWeekStartSql(Prisma.sql`l."createdAt"`, r.tz, opts.lang)} AS "week", COUNT(*)::int AS "leads", 0 AS "won"
      FROM (${leadsCte(ws, r, opts)}) l GROUP BY 1
      UNION ALL
      SELECT w."week", 0, COUNT(DISTINCT w."ticketId")::int
      FROM (
        SELECT ${localWeekStartSql(Prisma.sql`a."createdAt"`, r.tz, opts.lang)} AS "week", a."ticketId"
        ${movesFrom(ws, r, opts, "won")}
      ) w GROUP BY 1
    )
    SELECT to_char(k."week", 'YYYY-MM-DD') AS "week", SUM(k."leads")::int AS "leads", SUM(k."won")::int AS "won"
    FROM k GROUP BY k."week"`;
}

/** `sources[]`: per lead, first match: the ad of the contact's earliest
 *  (visible) conversation with one; else the channel kind of its earliest
 *  visible conversation; else Contact.source. With leads and won (leads of the
 *  range with a won move in range). Rows `{ kind, key, label, leads, won }`. */
export function sourcesSql(ws: string, r: InsightsRange, scope: ConversationScope, opts: SalesOpts): Prisma.Sql {
  return Prisma.sql`/* insights:sales.sources */
    WITH l AS (${leadsCte(ws, r, opts)}),
    src AS (
      SELECT l."id",
        (SELECT c."adSourceId" FROM "Conversation" c
          WHERE c."workspaceId" = ${ws} AND c."contactId" = l."contactId" AND c."adSourceId" IS NOT NULL
            ${conversationScopeSql(scope, "c")}
          ORDER BY c."createdAt", c."id" LIMIT 1) AS "adId",
        (SELECT lower(COALESCE(chn."kind", c."channel")) FROM "Conversation" c
          LEFT JOIN "Channel" chn ON chn."id" = c."channelId" AND chn."workspaceId" = ${ws}
          WHERE c."workspaceId" = ${ws} AND c."contactId" = l."contactId"
            ${conversationScopeSql(scope, "c")}
          ORDER BY c."createdAt", c."id" LIMIT 1) AS "channelKind",
        ct."source" AS "contactSource",
        EXISTS (SELECT 1 ${movesFrom(ws, r, opts, "won")} AND a."ticketId" = l."id") AS "won"
      FROM l JOIN "Contact" ct ON ct."id" = l."contactId"
    ),
    g AS (
      SELECT CASE WHEN src."adId" IS NOT NULL THEN 'ad' WHEN src."channelKind" IS NOT NULL THEN 'channel' ELSE 'contact_source' END AS "kind",
        COALESCE(src."adId", src."channelKind", src."contactSource") AS "key",
        COUNT(*)::int AS "leads", (COUNT(*) FILTER (WHERE src."won"))::int AS "won"
      FROM src GROUP BY 1, 2
    )
    SELECT g."kind", g."key", g."leads", g."won",
      CASE WHEN g."kind" = 'ad' THEN COALESCE(ad."adName", ad."headline", ad."sourceId") ELSE g."key" END AS "label"
    FROM g LEFT JOIN "AdSource" ad ON g."kind" = 'ad' AND ad."id" = g."key" AND ad."workspaceId" = ${ws}`;
}

/** `funnel[]`: per stage of P, leads of the range that reached it (an
 *  activity into it, creation included, or currently in it).
 *  Rows `{ stageId, key, label, labelAr, isWon, isTerminal, order, reached }`. */
export function funnelSql(ws: string, r: InsightsRange, _scope: ConversationScope, opts: SalesOpts): Prisma.Sql {
  return Prisma.sql`/* insights:sales.funnel */
    WITH l AS (${leadsCte(ws, r, opts)})
    SELECT st."id" AS "stageId", st."key", st."label", st."labelAr", st."isWon", st."isTerminal", st."order",
      (SELECT COUNT(*) FROM l
        WHERE l."stageId" = st."id"
          OR EXISTS (SELECT 1 FROM "TicketActivity" a WHERE a."ticketId" = l."id" AND a."toStage" = st."key"))::int AS "reached"
    FROM "TicketStage" st
    WHERE st."workspaceId" = ${ws} AND st."pipelineId" = ${opts.pipelineId}`;
}

/** `lostReasons[]`: tickets of P lost in range, by the ticket's catalog
 *  reason, else its snapshot text, else none.
 *  Rows `{ reasonId, label, labelAr, snapshot, n }`. */
export function lostReasonsSql(ws: string, r: InsightsRange, _scope: ConversationScope, opts: SalesOpts): Prisma.Sql {
  return Prisma.sql`/* insights:sales.lostReasons */
    WITH x AS (
      SELECT DISTINCT a."ticketId", t."lostReasonId", t."lostReason" ${movesFrom(ws, r, opts, "lost")}
    )
    SELECT lr."id" AS "reasonId", lr."label", lr."labelAr",
      CASE WHEN lr."id" IS NULL THEN NULLIF(btrim(x."lostReason"), '') END AS "snapshot",
      COUNT(DISTINCT x."ticketId")::int AS "n"
    FROM x LEFT JOIN "LostReason" lr ON lr."id" = x."lostReasonId" AND lr."workspaceId" = ${ws}
    GROUP BY lr."id", lr."label", lr."labelAr", 4`;
}

/**
 * `reps[]` totals per key (owner's user id, "~former", "~unassigned"): leads
 * (created in range), won/lost (distinct tickets with that move in range),
 * the median seconds to the first staff reply SENT BY THE OWNER (visible
 * conversations), and SP-04 follow-ups by assignee: done (doneAt in range),
 * overdue (open, due before now), dueToday (open, due from now to the end of
 * the local day). Rows `{ key, leads, won, lost, median, done, overdue, dueToday }`.
 */
export function repsSql(ws: string, r: InsightsRange, scope: ConversationScope, opts: SalesOpts): Prisma.Sql {
  const now = utcTimestampSql(opts.now);
  return Prisma.sql`/* insights:sales.reps */
    WITH l AS (${leadsCte(ws, r, opts)}),
    src AS (
      SELECT l."ownerId" AS "uid", 1 AS "leads", 0 AS "won", 0 AS "lost", 0 AS "done", 0 AS "overdue", 0 AS "dueToday" FROM l
      UNION ALL
      SELECT w."ownerId", 0, 1, 0, 0, 0, 0 FROM (SELECT DISTINCT a."ticketId", t."ownerId" ${movesFrom(ws, r, opts, "won")}) w
      UNION ALL
      SELECT x."ownerId", 0, 0, 1, 0, 0, 0 FROM (SELECT DISTINCT a."ticketId", t."ownerId" ${movesFrom(ws, r, opts, "lost")}) x
      UNION ALL
      SELECT f."assigneeId", 0, 0, 0,
        (CASE WHEN f."doneAt" IS NOT NULL AND ${inRangeSql(Prisma.sql`f."doneAt"`, r)} THEN 1 ELSE 0 END),
        (CASE WHEN f."doneAt" IS NULL AND f."dueAt" < ${now} THEN 1 ELSE 0 END),
        (CASE WHEN f."doneAt" IS NULL AND f."dueAt" >= ${now} AND f."dueAt" < ${utcTimestampSql(opts.todayEnd)} THEN 1 ELSE 0 END)
      FROM "Activity" f
      WHERE f."workspaceId" = ${ws}
        -- Only rows that can count: open ones (overdue / due today) and those
        -- done in range. Old done follow-ups are never read (review of Task 2).
        AND (f."doneAt" IS NULL OR (${inRangeSql(Prisma.sql`f."doneAt"`, r)}))
    ),
    tot AS (
      SELECT ${memberKeySql(ws, Prisma.sql`src."uid"`)} AS "key",
        SUM(src."leads")::int AS "leads", SUM(src."won")::int AS "won", SUM(src."lost")::int AS "lost",
        SUM(src."done")::int AS "done", SUM(src."overdue")::int AS "overdue", SUM(src."dueToday")::int AS "dueToday"
      FROM src GROUP BY 1
    ),
    sp AS (
      SELECT ${memberKeySql(ws, Prisma.sql`s."ownerId"`)} AS "key",
        ${medianSecondsSql(Prisma.sql`s."sec" * interval '1 second'`)} AS "median"
      FROM (
        SELECT l."ownerId", EXTRACT(EPOCH FROM (${firstStaffReplySql(ws, scope, "l", Prisma.sql`l."ownerId"`)} - l."createdAt"))::float8 AS "sec"
        FROM l WHERE l."ownerId" IS NOT NULL
      ) s
      WHERE s."sec" IS NOT NULL
      GROUP BY 1
    )
    SELECT COALESCE(tot."key", sp."key") AS "key",
      COALESCE(tot."leads", 0)::int AS "leads", COALESCE(tot."won", 0)::int AS "won", COALESCE(tot."lost", 0)::int AS "lost",
      COALESCE(tot."done", 0)::int AS "done", COALESCE(tot."overdue", 0)::int AS "overdue", COALESCE(tot."dueToday", 0)::int AS "dueToday",
      sp."median"::float8 AS "median"
    FROM tot FULL OUTER JOIN sp ON sp."key" = tot."key"`;
}
