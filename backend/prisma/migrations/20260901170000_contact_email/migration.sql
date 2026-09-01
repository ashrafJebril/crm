-- Add a tenant-scoped customer email used by booking workflows.
ALTER TABLE "Contact" ADD COLUMN "email" TEXT;
CREATE INDEX "Contact_workspaceId_email_idx" ON "Contact"("workspaceId", "email");
