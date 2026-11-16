-- SP-10 bookings catalog. Hand-written, additive and idempotent.
-- Equal to `prisma migrate diff --from-schema-datamodel <9b2a29d schema>
-- --to-schema-datamodel prisma/schema.prisma --script`, plus IF NOT EXISTS,
-- the duplicate_object wrappers around the foreign keys, the lock_timeout
-- below, and one reordering: every "Appointment" statement runs last.
-- Safe for the deployed main:
--   * Four new tables (Service, StaffResource, StaffService, CatalogImport)
--     that main never reads.
--   * Three Appointment columns: "serviceId" and "resourceId" are nullable,
--     "version" is NOT NULL with a constant default (metadata-only on
--     Postgres 11+, no rewrite). main's inserts leave them null/0, its updates
--     never touch them, and its HJZ push reads only the old columns. The
--     free-text "service"/"serviceAr" columns are kept for legacy and HJZ rows.
--   * Nothing newly references "Appointment"; main's deletes are unaffected.
--     The "Appointment_status_changed_at" trigger is untouched.
--   * No existing column, constraint or index changes; no data is rewritten.
--     No backfill: legacy bookings stay free-text (ruling 2).
--   * Locks: `prisma migrate deploy` runs this file as one transaction. The
--     ALTER TABLE "Appointment" takes ACCESS EXCLUSIVE on "Appointment" and
--     holds it until commit, so READS AND WRITES on "Appointment" (the
--     Calendar, the HJZ sweep, the agent) are blocked from that statement to
--     the end of the migration: its three index builds and the two FK
--     validations (all-null columns). The Appointment statements are
--     therefore last, to keep that hold short (seconds at our size; Task 6
--     records the row count). The new tables are created before it.
--   * lock_timeout: if a long transaction holds "Appointment", the ALTER gives
--     up after 5 s instead of queueing every later request behind it. The
--     script then rolls back, but Prisma records the migration as failed
--     (the next deploy stops with P3009). To retry: run
--     `npx prisma migrate resolve --rolled-back 20261116130000_bookings_catalog`,
--     then `npx prisma migrate deploy` again. The script is idempotent.
-- Apply with `prisma migrate deploy` only, after the user's explicit approval.

-- Give up instead of stalling the lock queue (review M1).
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE IF NOT EXISTS "Service" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT 'info',
    "durationMin" INTEGER NOT NULL,
    "price" DECIMAL(12,2),
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "archivedAt" TIMESTAMP(3),
    "order" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "StaffResource" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "role" TEXT,
    "color" TEXT NOT NULL DEFAULT 'accent',
    "schedule" JSONB NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "archivedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffResource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "StaffService" (
    "resourceId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffService_pkey" PRIMARY KEY ("resourceId","serviceId")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CatalogImport" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "createdById" TEXT,
    "source" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'extracting',
    "inputText" TEXT,
    "sourceUrl" TEXT,
    "fileMediaId" TEXT,
    "fileName" TEXT,
    "extractedBy" TEXT,
    "proposal" JSONB,
    "total" INTEGER NOT NULL DEFAULT 0,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "errorKey" TEXT,
    "heartbeatAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogImport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Service_workspaceId_active_idx" ON "Service"("workspaceId", "active");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StaffResource_workspaceId_active_idx" ON "StaffResource"("workspaceId", "active");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "StaffResource_workspaceId_userId_key" ON "StaffResource"("workspaceId", "userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StaffService_serviceId_idx" ON "StaffService"("serviceId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CatalogImport_workspaceId_createdAt_idx" ON "CatalogImport"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CatalogImport_status_heartbeatAt_idx" ON "CatalogImport"("status", "heartbeatAt");

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "Service" ADD CONSTRAINT "Service_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "StaffResource" ADD CONSTRAINT "StaffResource_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "StaffResource" ADD CONSTRAINT "StaffResource_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "StaffService" ADD CONSTRAINT "StaffService_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "StaffResource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "StaffService" ADD CONSTRAINT "StaffService_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "CatalogImport" ADD CONSTRAINT "CatalogImport_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "CatalogImport" ADD CONSTRAINT "CatalogImport_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "CatalogImport" ADD CONSTRAINT "CatalogImport_fileMediaId_fkey" FOREIGN KEY ("fileMediaId") REFERENCES "Media"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN IF NOT EXISTS "resourceId" TEXT,
ADD COLUMN IF NOT EXISTS "serviceId" TEXT,
ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Appointment_workspaceId_startAt_idx" ON "Appointment"("workspaceId", "startAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Appointment_workspaceId_resourceId_startAt_idx" ON "Appointment"("workspaceId", "resourceId", "startAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Appointment_workspaceId_serviceId_idx" ON "Appointment"("workspaceId", "serviceId");

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "StaffResource"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
