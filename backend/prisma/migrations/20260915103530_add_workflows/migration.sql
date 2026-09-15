-- CreateTable Workflow
CREATE TABLE "Workflow" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "triggerType" TEXT NOT NULL,
    "triggerConfig" JSONB NOT NULL DEFAULT '{}',
    "steps" JSONB NOT NULL DEFAULT '{"entry": null, "steps": {}}',
    "webhookSecret" TEXT,
    "lastScheduledAt" TIMESTAMP(3),
    "workspaceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable WorkflowRun
CREATE TABLE "WorkflowRun" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "context" JSONB NOT NULL DEFAULT '{}',
    "stepsSnapshot" JSONB NOT NULL DEFAULT '{}',
    "cursor" JSONB NOT NULL DEFAULT '{"stepId": null}',
    "result" JSONB NOT NULL DEFAULT '{}',
    "resumeAt" TIMESTAMP(3),
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "workflowId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "WorkflowRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex Workflow_workspaceId_idx
CREATE INDEX "Workflow_workspaceId_idx" ON "Workflow"("workspaceId");

-- CreateIndex Workflow_workspaceId_triggerType_status_idx
CREATE INDEX "Workflow_workspaceId_triggerType_status_idx" ON "Workflow"("workspaceId", "triggerType", "status");

-- CreateIndex WorkflowRun_workspaceId_workflowId_startedAt_idx
CREATE INDEX "WorkflowRun_workspaceId_workflowId_startedAt_idx" ON "WorkflowRun"("workspaceId", "workflowId", "startedAt");

-- CreateIndex WorkflowRun_status_resumeAt_idx
CREATE INDEX "WorkflowRun_status_resumeAt_idx" ON "WorkflowRun"("status", "resumeAt");

-- AddForeignKey Workflow
ALTER TABLE "Workflow" ADD CONSTRAINT "Workflow_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey WorkflowRun
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey WorkflowRun
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
