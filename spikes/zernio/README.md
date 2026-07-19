# Zernio spike

Throwaway harness to **validate Zernio before we migrate anything**. Nothing here is production code, and it does not touch our backend, Kapso, or our Meta apps. It exists to get an objective yes/no on the two claims our research could not confirm:

1. **No Meta App Review / no Tester-adding** — a customer connects Facebook/Instagram by "just authenticating."
2. **WhatsApp number provisioning** — Zernio can provision a working KSA/GCC number (with KYC) itself.

Decisions this spike serves are recorded in project memory (`project_zernio_evaluation`). Agreed scope: FB/IG/WhatsApp full inbox, TikTok publish+comments (DMs later via a specialist), Snapchat publish-only.

## Setup

- Node 18+ (uses built-in `fetch`). No `npm install` needed.
- `cp .env.example .env` and fill in `ZERNIO_API_KEY` (from zernio.com → Settings → API Keys).
- A public HTTPS tunnel to your machine, e.g. `ngrok http 4444` or `cloudflared tunnel --url http://localhost:4444`. Put the public URL in `ZERNIO_PUBLIC_URL`.
- In Zernio → Settings → Webhooks, create a webhook pointing at `$ZERNIO_PUBLIC_URL/webhooks/zernio`, subscribe to `message.received`, `account.connected`, and `whatsapp.number.*`, and copy the signing secret into `ZERNIO_WEBHOOK_SECRET`.

Load `.env` into your shell (it isn't auto-loaded):

```bash
# bash / git-bash
set -a; . ./.env; set +a
```
```powershell
# PowerShell
Get-Content .env | ForEach-Object { if ($_ -match '^\s*(\w+)\s*=\s*(.*)$') { Set-Item "env:$($matches[1])" $matches[2] } }
```

## The tests

Run the listener in one terminal; run commands in another.

```bash
node spike.mjs listen
```

### Test 1 — the make-or-break (FB + IG, no App Review)
```bash
node spike.mjs profile "Spike Customer"        # → prints profileId
node spike.mjs connect facebook  <profileId>   # open the printed authUrl in a browser on the TEST FB account
node spike.mjs connect instagram <profileId>
```
**PASS** if a brand-new FB/IG account we have never added anywhere connects, the consent screen shows **Zernio's** app, and no App Review / Tester step appears. Watch the listener for `account.connected` and the `/oauth/redirect` capture.

### Test 2 — inbound DMs + reply
From a phone, DM the connected IG/FB account. The listener should print a `message.received` with `✓ VALID` signature. Then reply:
```bash
node spike.mjs conversations <profileId>                 # find conversationId + accountId
node spike.mjs send <conversationId> <accountId> "hello from the spike"
```
**PASS** if the event arrives with a valid signature and the reply lands on the phone.

### Test 3 — WhatsApp provisioning (KSA/GCC)
```bash
node spike.mjs connect whatsapp <profileId>    # follow the Embedded Signup / number flow
```
Watch the listener for `whatsapp.number.kyc_submitted` → `whatsapp.number.activated` (or `declined`/`action_required`). **PASS** if we get a working KSA number without our own WABA/BSP, and we can observe the cost + KYC timeline.

### Test 4 — publish to the gap platforms
```bash
node spike.mjs connect tiktok   <profileId>
node spike.mjs connect snapchat <profileId>    # Snapchat needs a Public Profile
node spike.mjs accounts <profileId>            # get the accountId for each
node spike.mjs post tiktok   <accountId> "spike test post"
node spike.mjs post snapchat <accountId> "spike test post"
```
**PASS** if the post publishes and the account shows connected. (TikTok/Snapchat DMs are intentionally NOT tested — Snapchat has none, TikTok DMs need a separate specialist provider.)

## Notes / uncertainties to confirm against the live API
- `accounts/list-accounts` path is taken from the docs; if it 404s, check the live API reference for the exact accounts-list route and update `cmdAccounts`.
- The `message.received` payload field names in `summarizeEvent()` are best-effort — the docs didn't publish the exact schema. The listener prints the raw event too, so adjust once we see a real payload.
- Base URL is `https://zernio.com/api/v1`; override via `ZERNIO_BASE_URL` if it changes.
