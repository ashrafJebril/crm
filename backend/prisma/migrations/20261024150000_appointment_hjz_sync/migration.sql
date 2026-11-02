-- CRM bookings → HJZ appointments.
ALTER TABLE "Appointment" ADD COLUMN "hjzAppointmentId" TEXT;
ALTER TABLE "Appointment" ADD COLUMN "hjzSyncPending" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Appointment" ADD COLUMN "hjzSyncAttemptAt" TIMESTAMP(3);
ALTER TABLE "Appointment" ADD COLUMN "hjzSyncError" TEXT;

-- Upcoming bookings of connected workspaces go to HJZ on the first sweep.
UPDATE "Appointment" a SET "hjzSyncPending" = true
FROM "Workspace" w
WHERE a."workspaceId" = w.id AND w."externalTenantId" IS NOT NULL
  AND a."startAt" >= NOW() AND a.status <> 'cancelled';

CREATE INDEX "Appointment_hjzSyncPending_idx" ON "Appointment"("hjzSyncPending");
