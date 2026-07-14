-- Drop AI / knowledge / mentions / keywords / scheduled-posts tables and the
-- workspace AI fields. Tables are dropped with CASCADE to clean up any
-- remaining indexes / FKs in one shot.

-- AI reply audit log
DROP TABLE IF EXISTS "AiReply" CASCADE;

-- Knowledge base (RAG)
DROP TABLE IF EXISTS "KnowledgeChunk" CASCADE;
DROP TABLE IF EXISTS "KnowledgeDocument" CASCADE;

-- Scheduled posts (publish queue)
DROP TABLE IF EXISTS "ScheduledPost" CASCADE;

-- Social listening
DROP TABLE IF EXISTS "Mention" CASCADE;
DROP TABLE IF EXISTS "Keyword" CASCADE;

-- Per-workspace AI toggles
ALTER TABLE "Workspace" DROP COLUMN IF EXISTS "aiAutoReplyEnabled";
ALTER TABLE "Workspace" DROP COLUMN IF EXISTS "aiConfidenceThreshold";
