# SP-24 lifecycle messages: rollback runbook

Rolling the backend back below SP-24 while a system workflow is active is
unsafe: the older code would dispatch an active `lifecycle.*` workflow on
`ticket_created`, fail it on the unknown `notify_staff` step, and list system
rows as editable (and deletable) user workflows.

## Before deploying any backend older than SP-24

1. Gate query (must return 0 before the rollback):

   ```sql
   SELECT count(*) FROM "Workflow" WHERE "systemKey" IS NOT NULL AND status = 'active';
   ```

2. If it is not 0, deactivate every system workflow (and cancel their parked
   runs, so nothing sends later from the payment-lock queue):

   ```sql
   BEGIN;
   UPDATE "WorkflowRun" SET status = 'cancelled', "completedAt" = now()
    WHERE status = 'waiting'
      AND "workflowId" IN (SELECT id FROM "Workflow" WHERE "systemKey" IS NOT NULL);
   UPDATE "Workflow" SET status = 'draft', "updatedAt" = now()
    WHERE "systemKey" IS NOT NULL AND status = 'active';
   COMMIT;
   ```

3. Run the gate query again: it must return 0. Then roll back.

## Notes

- The migration `20261117150000_lifecycle_messages` stays applied: the
  nullable `Workflow.systemKey` column, its unique index and the
  `LifecycleDelivery` table are invisible to older code. Do not drop them.
- After rolling forward again, owners switch the messages back on from
  Settings → Automatic messages (the setup is kept; only the switch is off).
