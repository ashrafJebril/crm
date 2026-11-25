# Campaign launch (SP-13): rollback runbook

For the on-call engineer who needs to roll the backend back to a release from
before SP-13 (campaign sending options, partitioned broadcasts, direct sends and
background launch).

> **The rule:** do not roll back below SP-13 while any SP-13 campaign may still
> be sending. Run the gate query below first. It must return **0 rows**. If it
> returns rows, cancel those campaigns with the SP-13 code that is still
> deployed, or wait for them to finish, then run the gate again.

This runbook covers the **code** rollback only. Do not roll back the SP-13
database migrations. The older code does not use the new columns and tables,
and the forward redeploy needs them.

---

## 1 · Why a rollback is dangerous

SP-13 can send one campaign as several Zernio broadcasts (one per sending
number and value set, called partitions, stored in `CampaignBroadcast`), or as
one direct message per recipient. Code from before SP-13 only knows one
broadcast per campaign (`Campaign.zernioBroadcastId`, which SP-13 points at
partition 1). After a rollback, the old code mishandles SP-13 campaigns in
these ways:

| # | Situation | What the old code does | Impact |
|---|---|---|---|
| 1 | **Cancel on a campaign with several partitions** | It cancels `zernioBroadcastId` only, which is partition 1. | Partitions 2..N keep sending after the user pressed Cancel. Messages go out after a cancel. |
| 2 | **Sync of a campaign with several partitions** | Its 5-minute sync reads only the first broadcast. When partition 1 completes, the campaign is marked `completed` while other partitions are still sending. | The status is wrong. After the forward redeploy the sync no longer selects the campaign, because `completed` is a finished state. Only the recipient tail sweep runs, so the status stays wrong. |
| 3 | **Delete of a `failed` or `cancelled` campaign with a live partition** | It allows the delete. The cascade removes the `CampaignBroadcast` rows. | The only record of a broadcast that is still sending is lost. Nothing can cancel it from the CRM any more. SP-13's `campaigns.has_live_broadcasts` guard is bypassed. |
| 4 | **A campaign in `launching`** (R14) | It ignores it (its sync selects only `scheduled`/`running` with a broadcast id), never resumes it, and allows deleting it. | The launch stalls. If some partitions were already sent, deleting it loses them as in row 3. Nothing is sent twice. |
| 5 | **A scheduled direct campaign** (`status = 'scheduled'`, `sendTransport = 'direct'`, no broadcast id) | It never starts it. Direct sends are started by the SP-13 scheduler at `scheduledAt`. | Recipients get nothing at the scheduled time. After the forward redeploy, the scheduler starts it late, as soon as it runs. |

---

## 2 · The gate: run this before any rollback

Run it read-only against the production database. It must return **0 rows**.

```sql
SELECT id, status, "sendTransport" FROM "Campaign"
WHERE status = 'launching'
   OR ("sendTransport" IS NOT NULL AND status IN ('scheduled','running'))
   OR ("sendTransport" = 'broadcast' AND status IN ('failed','cancelled')
       AND EXISTS (SELECT 1 FROM "CampaignBroadcast" b WHERE b."campaignId" = "Campaign".id
                   AND b.stage IN ('sent','scheduled')));
```

What each line catches:

- `status = 'launching'`: a background launch in progress (row 4 above).
- `"sendTransport" IS NOT NULL AND status IN ('scheduled','running')`: an SP-13
  campaign that is sending or waiting to send, including multi-partition
  broadcasts (rows 1 and 2) and scheduled direct campaigns (row 5).
- the last condition: a `failed` or `cancelled` broadcast campaign with a
  partition our records still call sent or scheduled. Its stop was not
  confirmed, so it may still be sending (row 3).

---

## 3 · If the gate returns rows

Do **not** roll back yet. For each campaign id returned, either cancel it or
wait for it, using the SP-13 code that is still deployed:

1. **Cancel it.** In the CRM open Campaigns, find the campaign and press
   **Cancel** (on the list or on its report). The API equivalent is
   `POST /campaigns/:id/cancel` as a user with `campaigns.manage`.
   - A `launching` campaign is cancelled by its background job. It stays
     `launching` for a moment, then ends `cancelled`. If the job had crashed,
     the scheduler resumes it within 2 to 3 minutes.
   - If a partition could not be stopped, the cancel reports an error and
     **Cancel stays offered**. Press it again until it succeeds.
2. **Or wait.** A `running` broadcast campaign leaves the gate once Zernio
   reports every partition finished and the sync marks it `completed`. A
   `launching` campaign leaves it once its launch ends. A scheduled campaign
   leaves it only after its send time and its sending, so for a rollback that
   cannot wait, cancel it instead.
3. **Run the gate again.** Roll back only when it returns 0 rows. Campaigns
   can start between the check and the deploy, so run it again right before
   the rollback and keep the window short.

If a campaign still cannot be cancelled (Zernio keeps refusing), do not roll
back. Escalate with the campaign id, the partition `lastError` values from
`CampaignBroadcast`, and the Zernio broadcast ids.

---

## 4 · R14 note

SP-13 ruling R14 accepted that a rollback with `launching` rows stalls those
campaigns, and asked for a runbook note: before rolling back, wait until no
campaign is `launching`:

```sql
SELECT count(*) FROM "Campaign" WHERE status = 'launching';
```

The SP-13 final review found that `launching` is only one of the risky cases
(section 1). The gate in section 2 includes the R14 check, so running the gate
is enough. The R14 count alone is **not** a safe gate.
