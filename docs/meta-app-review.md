# Meta App Review: Kewy Marketing (app 1733639664328456)

Answers to paste into **Review → App Review** for each permission. Every
permission needs a screen recording of the real flow, made with an account that
has a role on the app.

## How a reviewer tests it

1. Open https://marketing.kewy.ai and sign in with the test workspace credentials
   given in the submission's "Test instructions" field.
2. Go to **Settings → Integrations**.
3. Click **Connect with Meta** for Facebook / Instagram, or **Connect WhatsApp**.
4. Complete the Meta popup, then open **Inbox**, **Publishing** and **Contacts**.

## Facebook Pages

| Permission | How Kewy Marketing uses it |
|---|---|
| `pages_show_list` | After the business owner logs in, we list the Pages they manage so they can choose which Page to connect to their Kewy workspace. |
| `pages_manage_metadata` | We subscribe the connected Page to webhooks so new messages and comments reach the shared inbox in real time. |
| `pages_messaging` | Agents read and reply to Messenger conversations with the Page's customers from the shared inbox, inside the 24-hour window or with the human agent tag. |
| `pages_read_engagement` | We read the Page's posts, followers' names and profile pictures to show who is writing in the inbox and to show post performance in Analytics. |
| `pages_read_user_content` | We show visitors' comments on the Page's posts in the inbox so agents can answer them, and let agents remove abusive comments. |
| `pages_manage_engagement` | Agents reply to, hide or delete comments on the Page's posts from the inbox. |
| `pages_manage_posts` | The business schedules and publishes posts to its own Page from the Publishing calendar. |
| `business_management` | We read the Business Manager portfolio the owner picks so the Pages, Instagram accounts and WhatsApp accounts it owns can be connected. |
| Business Asset User Profile Access | Shows the name and profile picture of customers who message the business, so agents know who they are talking to. |

## Instagram

| Permission | How Kewy Marketing uses it |
|---|---|
| `instagram_basic` | We read the connected Instagram professional account's profile and media to show it in Settings and next to its posts. |
| `instagram_manage_messages` | Agents read and reply to Instagram Direct messages from the shared inbox. |
| `instagram_manage_comments` | Agents read, reply to and hide comments on the account's posts from the inbox. |
| `instagram_content_publish` | The business schedules and publishes feed posts to its own Instagram account from the Publishing calendar. |

## WhatsApp (after Tech Provider onboarding)

| Permission | How Kewy Marketing uses it |
|---|---|
| `whatsapp_business_management` | Through Embedded Signup the business connects its WhatsApp Business Account; we read its phone numbers and message templates and subscribe the account to webhooks. |
| `whatsapp_business_messaging` | Agents and approved automations send and receive WhatsApp messages with the business's customers from the shared inbox. |

## Screen recordings to make

1. **Facebook connect + inbox:** connect a Page, receive a Messenger message, reply,
   answer and hide a comment.
2. **Publishing:** schedule a post to the Page and to Instagram and show it published.
3. **Instagram inbox:** receive and reply to a DM, reply to a comment.
4. **WhatsApp:** Embedded Signup, then send and receive a message.

Show the Meta login dialog with the permissions listed, then each feature using
them. English UI, no cuts in the middle of a flow.

## Data handling answers

- Privacy policy: https://marketing.kewy.ai/privacy
- Data deletion callback: https://api-marketing.kewy.ai/api/meta/data-deletion
- Deauthorize callback: https://api-marketing.kewy.ai/api/meta/deauthorize
- Data is stored on Fly.io (Frankfurt) and never sold or used for advertising.
