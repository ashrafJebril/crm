# Meta Tech Provider — Direct Connect (Project 1)

Date: 2026-11-06 · Branch: `feat/meta-tech-provider`

## Why

The owner is applying to become a Meta **Tech Provider** so customers can connect
WhatsApp, Facebook Messenger and Instagram to the CRM themselves, with no
onboarding call and no copying tokens out of Business Manager. Approval
(business verification + App Review) takes weeks, so the code is prepared now
and stays switched off until approval.

This is **project 1 of 2**. Project 2 (later, separate design) removes Zernio and
moves its features (inbox, posting/scheduling, comments, analytics, campaigns,
template sends) onto the direct Meta connection. Project 1 must not break or
change anything Zernio does today.

## Goals

1. **One Meta app** for WhatsApp, Facebook and Instagram (owner decision).
2. **Popup connect** for each channel from Settings → Integrations:
   - **WhatsApp:** Meta Embedded Signup popup (`FB.login` with a `config_id`).
     The customer picks or creates their business, WABA and number; we exchange the
     code, register the number, subscribe our app to the WABA, and save the
     integration.
   - **Facebook:** Facebook Login for Business (a `config_id`-based login
     configuration instead of the raw `scope` list). The customer picks a Page; we
     store the Page token and subscribe the Page to our app's webhooks.
   - **Instagram:** goes **through the customer's linked Facebook Page**, which is
     what the code does today (`instagram_business_account` lookup after FB
     connect). Connecting Facebook also connects the linked Instagram account.
3. **Token-paste stays as a backup** for all three (owner decision). The
   existing `connect-by-token`, manual `connect`, and FB `connect` endpoints
   keep working.
4. **One webhook setup.** WhatsApp uses the same single app, the same app secret,
   and one verify token from env (no per-integration random verify tokens).
5. **Meta compliance callbacks** that App Review requires: deauthorize callback
   and data-deletion callback (signed_request), plus a public status page for
   deletion requests.
6. **Off by default.** One switch hides the new popup buttons until approval.

## Non-goals

- Removing or changing Zernio (project 2).
- TikTok, Threads.
- Instagram accounts with no linked Facebook Page ("Instagram API with
  Instagram Login").
- Solution Partner features (credit lines, billing customers for Meta
  conversation charges).
- Multiple WhatsApp numbers or Pages per workspace. The
  `@@unique([workspaceId, platform])` model stays as is.
- The Meta-dashboard steps themselves (business verification, App Review
  submission). Those are the owner's; this project only provides what the
  submission needs (working flows and callback URLs).

## Anti-goals (failure even if it "works")

- Any existing customer connection breaking: current token-based WhatsApp, FB
  and IG integrations, and anything provider=`zernio`.
- A customer seeing a Connect button that errors because the app isn't
  approved yet.
- Webhooks accepted without signature verification.
- Tokens stored unencrypted. Use the existing `encryptSecret`.

## Current state (what exists)

- `backend/src/integrations/whatsapp.service.ts`
  - `connect()` validates, calls `subscribed_apps`, and upserts the Integration.
  - `connectByToken()`: paste-one-token discovery (debug_token → `/me/businesses`).
  - `embeddedSignupExchange(code, phoneNumberId, wabaId)` already exists and is
    exposed at `POST /integrations/whatsapp/oauth/exchange`, **but no UI calls it**.
    It doesn't register the phone number and generates a random verify token.
  - Webhook: `GET/POST /webhooks/whatsapp`; the verify step checks per-row
    `verifyToken`.
  - Uses `META_APP_ID_WA`/`META_APP_SECRET_WA`, falling back to `META_APP_ID`/`META_APP_SECRET`.
- `backend/src/integrations/facebook.controller.ts`: redirect OAuth
  (`oauth/start` → `oauth/callback`) with a JWT `state` and a hard-coded
  `OAUTH_SCOPES`. `facebook.service.ts` `connect()` picks a Page and
  subscribes it; IG is auto-derived from the Page.
- `backend/src/integrations/meta-webhooks.*`: app-level `/webhooks/meta` for
  `object=page|instagram`, verify via `META_VERIFY_TOKEN`.
- `backend/src/common/meta-webhook-signature.guard.ts`: picks the secret by path
  (`_WA` secret for `/webhooks/whatsapp`).
- Frontend `src/screens/settings/IntegrationsTab.tsx`: loads the FB SDK
  (`index.html`), calls `FB.init` with `VITE_WA_APP_ID`, listens for
  `WA_EMBEDDED_SIGNUP` messages, has types for `FB.login` with `config_id`, but
  has no button that launches it. The FB card uses `useConnectFlow` (redirect,
  or popup when embedded in an iframe).

## Design (decided)

### Configuration

- Backend env: `META_APP_ID`, `META_APP_SECRET`, `META_VERIFY_TOKEN` (one app),
  plus new `META_WA_CONFIG_ID` (Embedded Signup login configuration) and
  `META_FB_CONFIG_ID` (Facebook Login for Business configuration).
- `META_APP_ID_WA` / `META_APP_SECRET_WA` become **deprecated fallbacks**. Code
  reads `META_APP_ID`/`META_APP_SECRET` first. Existing WhatsApp integrations made
  under the old WA app keep working, because their stored tokens are system-user
  tokens tied to the old app. The signature guard must accept **either** secret
  on `/webhooks/whatsapp` while both apps are live (try primary, then legacy).
- **The switch:** backend env `META_TECH_PROVIDER_ENABLED` (default `false`).
  Exposed to the frontend by a small authenticated endpoint
  (`GET /integrations/meta/config` → `{ enabled, appId, waConfigId,
  fbConfigId, graphVersion }`) so the frontend doesn't need a rebuild to turn it
  on. When disabled, the endpoint returns `{ enabled: false }` and the popup
  buttons don't render. The backend popup endpoints also refuse with 403 when
  disabled.

### WhatsApp Embedded Signup

1. Frontend: "Connect with Meta" button → `FB.login(cb, { config_id:
   waConfigId, response_type: "code", override_default_response_type: true,
   extras: { setup: {}, featureType: "", sessionInfoVersion: "3" } })`.
2. Capture `waba_id` and `phone_number_id` from the `WA_EMBEDDED_SIGNUP`
   message (existing listener) and `code` from the login callback. Then POST
   `/integrations/whatsapp/oauth/exchange`.
3. Backend `embeddedSignupExchange`:
   - Exchange the code for a business token using the single app.
   - **Register the phone number** (`POST /{phone_number_id}/register` with
     `messaging_product=whatsapp` and a 6-digit PIN that we generate and store
     encrypted in `raw`). If Meta says it's already registered, continue.
   - Call `subscribed_apps` on the WABA (existing).
   - Fetch `display_phone_number` and `verified_name` for the Integration row.
   - Save it through the existing `connect()` path, with no random verify token.
4. Frontend shows the connected number, or Meta's error text if it fails. If the
   user closes the popup, nothing happens.

### Facebook (+ Instagram) via Login for Business

- `oauth/start` uses `config_id=META_FB_CONFIG_ID` when the switch is on,
  instead of `scope=OAUTH_SCOPES`. The rest of the redirect flow, state JWT,
  callback, `fb.connect()`, Page subscription and IG derivation stay as they are.
- If the user has several Pages, keep the current behaviour (pick first;
  `select-page` endpoint to switch). The UI already has a page switcher.
- When the switch is off, the existing scope-based OAuth button behaves exactly
  as today. That's the "backup" for Facebook alongside the token connect.

### Webhooks

- WhatsApp webhook verify (`GET /webhooks/whatsapp`) accepts
  `META_VERIFY_TOKEN`, and keeps accepting existing per-row tokens so old setups
  don't break.
- `/webhooks/meta` stays as is for Page and IG. Whether WhatsApp events move to
  `/webhooks/meta` (object=`whatsapp_business_account`) or stay on
  `/webhooks/whatsapp` is left to the builder, as long as one app can be
  configured with one callback per product.

### Compliance callbacks (public, no auth)

- `POST /api/meta/deauthorize`: parse and verify `signed_request` (HMAC-SHA256
  with the app secret). Mark that user's Meta-provider integrations
  disconnected (delete the rows, matching current disconnect behaviour). Never
  touch `provider=zernio` rows.
- `POST /api/meta/data-deletion`: verify `signed_request`, delete or disconnect
  the same way, and respond `{ url, confirmation_code }` per Meta's spec.
  `url` points to a simple public status page.
- To match `signed_request.user_id` (app-scoped user id) to integrations, store
  the connecting user's app-scoped id in Integration `raw` at connect time
  (`/me?fields=id` with the user token).

### UI (Settings → Integrations)

- WhatsApp card: when enabled, the primary action is **"Connect with Meta"**
  (popup). The token-paste form moves under a "Use an access token instead"
  disclosure. When disabled, the card looks exactly as today.
- Facebook card: same button, now using Login for Business when enabled.
  Instagram card: unchanged, and keeps saying it connects through Facebook.
- All new strings bilingual via `tx(en, ar)` like the rest of the file.

### Docs

- Update `docs/whatsapp-connect-runbook.md` with the popup flow and keep the
  token flow as "backup".
- Add a short `docs/meta-tech-provider-setup.md`: env vars, the Meta dashboard
  values to paste (callback URLs, deauth/deletion URLs, login configurations and
  their permissions), and what to record for App Review screencasts.

## Testing

- Unit tests (jest, existing `*.spec.ts` style) for `signed_request` parsing and
  verification, the switch guard, `embeddedSignupExchange` (register + subscribe
  + idempotent "already registered"), and the dual-secret signature guard.
- A frontend test that the popup buttons don't render when disabled.
- Manual end-to-end test in Meta **development mode** with the owner's own
  business account (app admins and testers can finish the flows before approval).

## Decisions after review

- **Zernio coexistence (owner approved suggestion):** when the switch is on, the
  new Meta popup is offered only for platforms the workspace has *not* connected
  through Zernio. A Zernio-connected platform shows "Connected via Zernio" and the
  backend refuses a Meta connect for it (409) instead of overwriting the row.
  Moving Zernio customers over is project 2.
- **Single app (owner approved suggestion):** `META_APP_ID=2203796510457334`
  (today's FB/IG app) is the one app; it stays env-configured.
- **Nothing moves before the switch (my call):** while
  `META_TECH_PROVIDER_ENABLED` is off, WhatsApp paths keep using
  `META_APP_ID_WA`/`META_APP_SECRET_WA` exactly as today. When it's on, the
  primary app is used and the `_WA` values remain as a fallback for verifying
  webhooks and debugging old tokens.
- **Data deletion scope (owner approved suggestion):** deauthorize/deletion
  removes only Meta-provider Integration rows (tokens, ids) for that user.
  Conversations, messages and contacts are the customer business's CRM data and
  are kept; the privacy policy must say so.
- **Matching deletion requests (my call):** the app-scoped user id is taken from
  the Meta login (`authResponse.userID` for the popup; `/me` with the user token
  for the FB redirect) and stored in `raw.metaUserId`. Rows connected by token
  paste have no id and aren't matched; they never used our login.

## Left to the builder

- Exact component structure, file splits, and DTO shapes.
- Whether WhatsApp webhooks move to `/webhooks/meta` (see above).
- Error message wording.
- PIN generation details.
