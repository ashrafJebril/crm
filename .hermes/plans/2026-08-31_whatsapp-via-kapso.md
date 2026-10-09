# Restore Kapso as the WhatsApp provider (drop Zernio for WhatsApp)

Status: **planning → in progress**
Branch: `feat/whatsapp-via-kapso` (off `feat/ai-agent-bridge`)
Date: 2026-08-31

## The bug, confirmed

Ashraf sends a WhatsApp message to the business number. His phone shows two
checks (Meta accepted it). It never appears in the CRM.

Verified against production:

```
POST https://kewy-marketing-api.fly.dev/api/webhooks/kapso   -> 404 Not Found
POST https://kewy-marketing-api.fly.dev/api/webhooks/zernio   -> 403 (alive)
```

Kapso is still configured to deliver to `/api/webhooks/kapso`, and that route
**no longer exists**. Commit `9fca845 chore: land pending Kapso-removal and
Zernio consolidation work` deleted it, together with a migration
`20260811150000_remove_kapso` dropping `Workspace.kapsoCustomerId`.

Every inbound WhatsApp message since has been dropped on the floor. Newest
message in the production database: **2026-08-28 19:46**.

`KAPSO_API_KEY` is still set in `.env`, which is why it looked configured.
`KAPSO_WEBHOOK_SECRET` is empty — so even a restored route would reject calls
until that is supplied.

## Decision

**WhatsApp runs on Kapso. Zernio is no longer used for WhatsApp.**

Zernio stays for Facebook and Instagram — it is the live path for those and
removing it is out of scope. This is specifically about the WhatsApp channel.

## What exists in git history (recover, do not rewrite)

| file | lines | role |
|---|---|---|
`backend/src/integrations/kapso.service.ts` | 557 | API client + `handleEvent` inbound |
`backend/src/integrations/kapso.controller.ts` | 85 | 5 routes incl. `POST webhooks/kapso` |
`backend/src/common/kapso-webhook-signature.guard.ts` | 45 | HMAC verification |
`src/components/KapsoRedirectCapture.tsx` | — | embedded-signup redirect |
`src/screens/settings/KapsoCard.tsx` | — | connect UI |

Old service methods: `isConfigured`, `createSetupLink`, `recordConnection`,
`status`, `disconnect`, `sendInConversation`, `sendText`, `handleEvent`.

Recovering beats rewriting: this code once worked against the real Kapso API,
so its payload shape is *captured*, not assumed. Rewriting it from the docs is
exactly how the seven upstream-contract bugs happened in kewy-ai.

## Plan

### Phase 1 — restore inbound (the actual outage)
1. `git show 9fca845~1:<path>` each deleted backend file back onto the branch.
2. Re-register `KapsoService` + `KapsoController` in `integrations.module.ts`.
3. Restore `Workspace.kapsoCustomerId` with a NEW forward migration (never edit
   or revert the old one — `remove_kapso` already ran on production).
4. Reconcile against current code: the repo moved on since August. Check
   `Conversation.externalId`, `Message`, and the workspace-context helper still
   have the shapes `handleEvent` expects. **Capture a real payload before
   trusting the mapper.**
5. Verify `POST /api/webhooks/kapso` answers 403 without a signature and 200
   with one — the same shape Zernio's endpoint gives today.

### Phase 2 — outbound
6. Route WhatsApp sends through `KapsoService.sendText` /
   `sendInConversation` instead of the Zernio/Meta path.
7. Keep the 24-hour-window rule: outside it, only a template may be sent.

### Phase 3 — the AI bridge
8. kewy-ai already posts drafts to `/api/ai/reply`; that path is provider
   agnostic and should need no change. **Verify, do not assume.**

### Phase 4 — UI
9. Restore `KapsoCard` in Settings → Integrations, and the redirect capture.
10. Remove WhatsApp from the Zernio card so there is one obvious place to
    connect a number.

## Hard requirements

- **Nothing is merged.** Branch only; Ashraf merges.
- **No migration against production Neon without explicit approval.** The
  restore migration is additive (one nullable column) but still needs a yes.
- `KAPSO_WEBHOOK_SECRET` must come from Ashraf via the Kapso dashboard →
  Integrations → Webhooks. It goes in `.env` / `fly secrets`, never in chat and
  never in a commit.
- The webhook must **fail closed**: no secret configured ⇒ reject, never accept
  unsigned traffic.
- Inbound must be **idempotent** — Kapso retries on non-200, and a duplicated
  customer message in the inbox is worse than a late one.
- A dropped message must be **logged loudly**. The whole reason this went
  unnoticed for three days is that a 404 is silent from the CRM's side.

## Open questions for Ashraf

1. `KAPSO_WEBHOOK_SECRET` — needed before inbound can work at all.
2. Is the number still connected in the Kapso dashboard, and is the webhook URL
   there pointed at `https://kewy-marketing-api.fly.dev/api/webhooks/kapso`?
3. Deploy to Fly when done, or leave it on the branch for him?
