-- SP-13 (T1 review M4): keyset paging of campaign audiences (preview and the launch plan stage):
-- WHERE "workspaceId" = $1 AND "id" > $2 ORDER BY "id" LIMIT 1000. Additive and idempotent; safe for the deployed main.
CREATE INDEX IF NOT EXISTS "Contact_workspaceId_id_idx" ON "Contact"("workspaceId", "id");
