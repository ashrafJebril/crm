# WhatsApp Cloud API — Connect & Disconnect Runbook

Practical runbook for onboarding a customer's WhatsApp number to tkana and —
just as important — offboarding them safely. Written for the no-app-review
setup (system-user token from the customer's own Business Manager).

> **The one rule that must never be broken:** a phone number registered on the
> Cloud API does **not** receive messages on the phone app anymore, and
> disconnecting from tkana does **not** put messages back on the phone. When
> offboarding, connect the replacement platform (or deregister the number)
> **before** disconnecting tkana — never leave a number orphaned.

---

## 1 · Onboarding a customer (no App Review needed)

### What the customer must already have

| # | Requirement | Notes |
|---|---|---|
| 1 | Meta Business Manager account | business.facebook.com |
| 2 | WhatsApp Business Account (WABA) | Business Settings → Accounts → WhatsApp Accounts → Add |
| 3 | Phone number registered to the WABA | Must NOT be active on a personal/business WhatsApp phone app — they must delete it from the app first |
| 4 | Business verification (recommended) | Without it, messaging is limited to ~5 test recipients. Can run in parallel with testing |

### Steps the customer does (on the call, in THEIR Business Manager)

1. **Create a system user**
   - Business Settings → Users → System Users → **Add**
   - Name: e.g. `Aram Integration`, Role: **Admin**
2. **Assign assets to the system user**
   - System user → **Add Assets** → **WhatsApp Accounts** → their WABA → **Full Control**
   - **Add Assets** → **Apps** → the Aram WhatsApp app → **Develop App**
3. **Generate the token**
   - System user → **Generate New Token**
   - App: the Aram WhatsApp app · Expiration: **Never**
   - Permissions (all three required):
     - `whatsapp_business_management`
     - `whatsapp_business_messaging`
     - `business_management`
   - Copy the token — it is shown only once. Token starts with `EA…`.

### What they send us

**Only the token.** WABA id and phone-number id are auto-discovered from the
token (`POST /api/integrations/whatsapp/connect-by-token` →
`connectByToken()` in `backend/src/integrations/whatsapp.service.ts`).

Discovery order:
1. `debug_token` granular scopes (requires `META_APP_ID_WA` +
   `META_APP_SECRET_WA` in `backend/.env` — both are set).
2. Fallback: `/me/businesses` → `owned_whatsapp_business_accounts`.

### Steps on our side

1. Settings → Integrations → WhatsApp → paste token → **Connect**.
2. The connect call auto-subscribes our app to the WABA webhooks
   (`subscribed_apps`) and generates a `verifyToken` (`aram-wa-…`).
3. **Configure the webhook** in our Meta app (WhatsApp → Configuration):
   - Callback URL: `https://<public-backend-domain>/api/webhooks/whatsapp`
   - Verify token: the `verifyToken` returned by connect (stored on the
     Integration row)
   - Subscribed fields: `messages`, `message_template_status_update`
   - ⚠ Localhost won't receive webhooks — use the deployed backend or ngrok.

### Gotchas

- **Multiple WABAs / phones on one token**: the code picks the FIRST of each.
  The connect response includes `discovered.wabas[]` and `picked{}` — verify
  it grabbed the right one. If not, use the manual
  `POST /api/integrations/whatsapp/connect` with explicit `phoneNumberId`,
  `wabaId`, `accessToken`, `verifyToken`.
- **Wrong token type**: a personal Facebook user token gets rejected with
  "Token rejected by Meta". It must come from **System Users**.
- **Temporary token** (WhatsApp Manager → API Setup) also works but dies in
  24 h — demo only, never for production.

### Smoke test before ending the call

Send a WhatsApp message from any allow-listed test number **to** the
customer's business number → it must appear in the tkana Inbox. Reply from
Inbox → must arrive on the sender's phone.

---

## 2 · Offboarding a customer (moving platforms / leaving)

### Why this is safe (zero lock-in)

Everything important lives in the **customer's** Business Manager, not ours:
the WABA, the phone number + its quality rating and messaging limits,
business verification, and all approved templates. We only hold a token.

What stays with us: their chat history inside tkana (offer an export).

### Correct offboarding order

1. **FIRST — new home for the number:**
   - Moving to another platform (360dialog, Wati, Twilio, own app…): customer
     grants that platform access to the same WABA. Templates and the number
     follow automatically.
   - Going back to the phone app: **deregister** the number from Cloud API
     (WhatsApp Manager → phone number settings, or `/{phone-number-id}/deregister`),
     then re-register it in the WhatsApp / WA Business app via SMS
     verification.
2. **THEN — disconnect tkana:**
   - Settings → Integrations → WhatsApp → Disconnect
     (`DELETE /api/integrations/whatsapp/disconnect`) — unsubscribes our app
     from the WABA webhooks and deletes our stored token.
3. **Customer-side cleanup:** delete the `Aram Integration` system user (or
   revoke its token) in their Business Manager.

### What happens if the order is violated

Number stays registered on Cloud API with nobody subscribed → inbound
messages are delivered to no one (not the phone, not any platform) until a
new subscriber appears or the number is deregistered. Senders see the message
as sent; the business silently misses it.

---

## 3 · When we get App Review one day

Nothing breaks and nothing needs migrating:

- Existing token-based connections keep working as-is.
- App Review unlocks **Embedded Signup** (OAuth popup) — endpoint already
  implemented: `POST /api/integrations/whatsapp/oauth/exchange`.
- New customers onboard with two clicks instead of the system-user-token
  procedure; existing customers can stay on their tokens indefinitely.
