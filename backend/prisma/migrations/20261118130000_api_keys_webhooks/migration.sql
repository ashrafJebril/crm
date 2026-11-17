-- SP-27 organization API keys and outgoing webhooks: the ApiKey,
-- WebhookEndpoint and WebhookDelivery tables. Additive and idempotent; no
-- backfill. (OAuth for MCP is deferred, so its tables and the Workspace /
-- WorkspaceMember AI-tools columns are not part of this migration.)
--
-- Safe for the deployed main: three new tables unknown to main; no existing
-- table, column, constraint or index changes. No UPDATE, DELETE, DROP or type
-- change. main never sees crm_ tokens: they fail its JWT check (401).
--
-- The FKs take a brief SHARE ROW EXCLUSIVE lock on "Workspace" and "User".
-- lock_timeout makes the DDL give up after 5 s instead of queueing requests
-- behind a long transaction; a timed-out deploy is simply rerun.
SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "ApiKey" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "scopes" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "WebhookEndpoint" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "description" TEXT,
    "events" TEXT[],
    "secretEnc" TEXT NOT NULL,
    "previousSecretEnc" TEXT,
    "previousSecretExpiresAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "disabledReason" TEXT,
    "failingSince" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMP(3),
    "responseCode" INTEGER,
    "lastError" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ApiKey_prefix_key" ON "ApiKey"("prefix");

CREATE UNIQUE INDEX IF NOT EXISTS "ApiKey_hash_key" ON "ApiKey"("hash");

CREATE INDEX IF NOT EXISTS "ApiKey_workspaceId_createdAt_idx" ON "ApiKey"("workspaceId", "createdAt");

CREATE INDEX IF NOT EXISTS "WebhookEndpoint_workspaceId_idx" ON "WebhookEndpoint"("workspaceId");

CREATE INDEX IF NOT EXISTS "WebhookDelivery_status_nextAttemptAt_idx" ON "WebhookDelivery"("status", "nextAttemptAt");

CREATE INDEX IF NOT EXISTS "WebhookDelivery_endpointId_createdAt_idx" ON "WebhookDelivery"("endpointId", "createdAt");

CREATE INDEX IF NOT EXISTS "WebhookDelivery_workspaceId_createdAt_idx" ON "WebhookDelivery"("workspaceId", "createdAt");

CREATE UNIQUE INDEX IF NOT EXISTS "WebhookDelivery_endpointId_eventId_key" ON "WebhookDelivery"("endpointId", "eventId");

DO $$ BEGIN
    ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "WebhookEndpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
