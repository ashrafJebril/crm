-- SP-23 connectors gallery: the Connector, ConnectorCall, ConnectorSyncLink
-- and ConnectorSyncRun tables. Additive and idempotent; no backfill.
--
-- Safe for the deployed main: four new tables main never reads. No existing
-- table, column, constraint or index changes. No UPDATE, DELETE, DROP or type
-- change. The legacy direct l MCP servers are untouched (ruling 9).
--
-- The FKs take a brief SHARE ROW EXCLUSIVE lock on "Workspace" and "User".
-- lock_timeout makes the DDL give up after 5 s instead of queueing requests
-- behind a long transaction; a timed-out deploy is simply rerun.
SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "Connector" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "authKind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "statusReason" TEXT,
    "serverUrl" TEXT NOT NULL,
    "tokenEnc" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "refreshFailures" INTEGER NOT NULL DEFAULT 0,
    "lastRefreshAt" TIMESTAMP(3),
    "headersEnc" TEXT,
    "oauthClientEnc" TEXT,
    "oauthMeta" JSONB,
    "oauthPendingEnc" TEXT,
    "oauthPendingExpiresAt" TIMESTAMP(3),
    "tools" JSONB NOT NULL DEFAULT '[]',
    "toolsScannedAt" TIMESTAMP(3),
    "accountLabel" TEXT,
    "lServerId" TEXT,
    "agentBound" BOOLEAN NOT NULL DEFAULT false,
    "proxyTokenPrefix" TEXT,
    "proxyTokenHash" TEXT,
    "sync" JSONB NOT NULL DEFAULT '{}',
    "connectedById" TEXT,
    "connectedAt" TIMESTAMP(3),
    "disconnectedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Connector_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ConnectorCall" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectorId" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "errorCode" TEXT,
    "durationMs" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'agent',
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConnectorCall_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ConnectorSyncLink" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectorId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "localId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectorSyncLink_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ConnectorSyncRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectorId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "added" INTEGER NOT NULL DEFAULT 0,
    "matched" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ConnectorSyncRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Connector_proxyTokenPrefix_key" ON "Connector"("proxyTokenPrefix");

CREATE INDEX IF NOT EXISTS "Connector_workspaceId_provider_idx" ON "Connector"("workspaceId", "provider");

CREATE INDEX IF NOT EXISTS "Connector_status_tokenExpiresAt_idx" ON "Connector"("status", "tokenExpiresAt");

CREATE INDEX IF NOT EXISTS "ConnectorCall_connectorId_at_idx" ON "ConnectorCall"("connectorId", "at");

CREATE INDEX IF NOT EXISTS "ConnectorCall_workspaceId_at_idx" ON "ConnectorCall"("workspaceId", "at");

CREATE INDEX IF NOT EXISTS "ConnectorSyncLink_workspaceId_idx" ON "ConnectorSyncLink"("workspaceId");

CREATE UNIQUE INDEX IF NOT EXISTS "ConnectorSyncLink_connectorId_kind_externalId_key" ON "ConnectorSyncLink"("connectorId", "kind", "externalId");

CREATE INDEX IF NOT EXISTS "ConnectorSyncRun_connectorId_startedAt_idx" ON "ConnectorSyncRun"("connectorId", "startedAt");

DO $$ BEGIN
    ALTER TABLE "Connector" ADD CONSTRAINT "Connector_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "Connector" ADD CONSTRAINT "Connector_connectedById_fkey" FOREIGN KEY ("connectedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "ConnectorCall" ADD CONSTRAINT "ConnectorCall_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "ConnectorCall" ADD CONSTRAINT "ConnectorCall_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "Connector"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "ConnectorSyncLink" ADD CONSTRAINT "ConnectorSyncLink_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "ConnectorSyncLink" ADD CONSTRAINT "ConnectorSyncLink_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "Connector"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "ConnectorSyncRun" ADD CONSTRAINT "ConnectorSyncRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "ConnectorSyncRun" ADD CONSTRAINT "ConnectorSyncRun_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "Connector"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
