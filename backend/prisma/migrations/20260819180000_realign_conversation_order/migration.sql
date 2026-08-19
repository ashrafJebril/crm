-- Repair ordering skew: mark-as-read used to bump Conversation.updatedAt
-- (the inbox list's sort key), hoisting merely-opened threads above ones
-- with newer messages. Realign updatedAt to the newest message's createdAt
-- so the list reflects actual message recency. Conversations without
-- messages keep their current updatedAt.
UPDATE "Conversation" c
SET "updatedAt" = m."last"
FROM (
  SELECT "conversationId", MAX("createdAt") AS "last"
  FROM "Message"
  GROUP BY "conversationId"
) m
WHERE m."conversationId" = c."id"
  AND c."updatedAt" <> m."last";
