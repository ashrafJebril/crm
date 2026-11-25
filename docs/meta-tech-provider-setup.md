# Meta Tech Provider — setup & switch-on checklist

The popup connect for WhatsApp, Facebook and Instagram is built and **off by
default**. This page covers what to configure in Meta and on the server, and how
to turn it on. Design: `docs/superpowers/specs/2026-11-06-meta-tech-provider-connect-design.md`.

## 1 · Meta app (one app for everything)

Use app `META_APP_ID` (today's FB/IG app). In developers.facebook.com:

| Setting | Value |
|---|---|
| Products | WhatsApp, Messenger, Instagram, Facebook Login for Business, Webhooks |
| App Domains | the frontend + backend domains |
| Privacy Policy URL | must state that deletion removes connection data (tokens, account ids); CRM messages/contacts belong to the business |
| Deauthorize callback URL | `https://<backend>/api/meta/deauthorize` |
| Data deletion callback URL | `https://<backend>/api/meta/data-deletion` |
| Facebook Login → Valid OAuth redirect URIs | `https://<backend>/api/integrations/facebook/oauth/callback` |
| Allowed domains for the JS SDK | the frontend domain (Embedded Signup popup) |

### Webhooks (one verify token: `META_VERIFY_TOKEN`)

| Object | Callback URL | Fields |
|---|---|---|
| WhatsApp Business Account | `https://<backend>/api/webhooks/whatsapp` | `messages`, `message_template_status_update` |
| Page | `https://<backend>/api/webhooks/meta` | `messages`, `messaging_postbacks`, `feed` |
| Instagram | `https://<backend>/api/webhooks/meta` | `messages`, `comments` |

### Login configurations (Facebook Login for Business → Configurations)

- **WhatsApp Embedded Signup** → login variation "WhatsApp Embedded Signup",
  permissions `whatsapp_business_management`, `whatsapp_business_messaging`,
  `business_management`. Copy its id → `META_WA_CONFIG_ID`.
- **Pages + Instagram** → user access token, permissions `pages_show_list`,
  `pages_read_engagement`, `pages_manage_posts`, `pages_manage_metadata`,
  `pages_manage_engagement`, `pages_messaging`, `pages_read_user_content`,
  `business_management`, `instagram_basic`, `instagram_manage_messages`,
  `instagram_manage_comments`, `instagram_content_publish`. Copy its id →
  `META_FB_CONFIG_ID`.

## 2 · Testing before approval

In development mode only people with a role on the app (admin, developer,
tester) can finish the popups. To try it on staging:

1. Set `META_TECH_PROVIDER_ENABLED=true`, `META_WA_CONFIG_ID`, `META_FB_CONFIG_ID`.
2. Use a workspace with **no Zernio** WhatsApp/Facebook connection (the popup
   isn't offered over Zernio, and the backend refuses with 409).
3. Settings → Integrations → WhatsApp → **Connect with Meta**; Facebook →
   **Connect Facebook** (now Login for Business). Instagram follows the Page.
4. These are the flows to screen-record for App Review.

## 3 · Switching on in production (after approval)

1. Set on the backend (fly secrets / `backend/fly.toml`):
   `META_TECH_PROVIDER_ENABLED=true`, `META_WA_CONFIG_ID`, `META_FB_CONFIG_ID`.
   No frontend rebuild needed — the UI reads `GET /api/integrations/meta/config`.
2. Keep `META_APP_ID_WA` / `META_APP_SECRET_WA` set while any customer is still
   connected through the old WhatsApp app (their webhooks are signed with it).

## What the switch changes

| | Off (today) | On |
|---|---|---|
| WhatsApp app for token exchange / debug_token | `META_APP_ID_WA` (fallback main) | `META_APP_ID` |
| WhatsApp card | token paste only | **Connect with Meta** + token paste backup |
| Facebook OAuth | classic `scope=` dialog (card hidden; Zernio) | Login for Business `config_id`; FB/IG cards shown unless Zernio owns Facebook |
| `POST /integrations/whatsapp/oauth/exchange` | 403 | Embedded Signup finish |

Always on (safe either way): `/webhooks/whatsapp` accepts signatures from either
app and the env `META_VERIFY_TOKEN`; Meta connects never overwrite Zernio rows;
deauthorize/data-deletion callbacks remove only Meta connection rows matched by
the app-scoped user id (token-paste rows carry none).
