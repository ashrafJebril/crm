# SP-31 Inbox Thread Enrichments: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The inbox thread becomes the full customer story:
- **Customer thread.** An optional "All conversations" view stitches every DB conversation of a contact across channels into one thread. Seams between conversations are labelled, and older segments load lazily.
- **Events in the thread.** Stage moves and ticket/booking events appear inline. The latest stage move made from the inbox can be undone within 10 minutes.
- **Customer reactions** show on the message they react to.
- **Template sends** gain a header image (upload, or pick from the library) and a preview step.
- **AI summary** gets topics and pain points, plus an on-demand translation (EN↔AR).
- **Linked items card.** The details panel shows the contact's linked tickets and bookings.
- **Saved replies.** Per-workspace canned replies replace the three hardcoded chips, with a `/shortcut` picker in the composer.

**Architecture:**
- **Thread events:** events are synthesized on read from existing data (`TicketActivity`, `Appointment` changes, SP-04 `Activity`). No new message rows are written, so nothing is duplicated and old threads get events retroactively. `GET /contacts/:id/thread?before=<cursor>` returns merged segments and events.
- **Reactions:** `Message` gains `reaction String?` and `reactionAt DateTime?`. Inbound reaction webhooks (Zernio `reaction.received`, Meta WA `reaction`) update the target message by its provider id (`metaMessageId`).
- **AI fields:** `Conversation` gains `topics Json?` and `painPoints Json?`, filled by the existing resolution verdict when the l agent returns them. The fields are optional, so they stay empty when absent. Translation calls the l agent's translate endpoint if one exists; otherwise it is a hidden feature flag. Rule: check `l-agent.service.ts`; if no translate capability exists, the button is hidden and the reason is documented.
- **Saved replies:** `SavedReply {workspaceId, title, body, bodyAr?, shortcut}`, unique on `shortcut` per workspace.
- **Template header:** the template picker gets a header-media step. Media is uploaded through the existing media library, then sent through the existing WhatsApp template-send path extended with header params.

**Tech Stack:** NestJS 10, Prisma 5, jest; React 18, vitest.

**Spec:** roadmap §SP-31. Tkana reference: `apps/web/app/routes/conversations.customer.$id.stream.ts`, `conversations.segment.$id.ts`, `components/conversations/{SegmentSeam,HandoffSeamMarker,ThreadEvent,reactions,SummaryStrip,TopicsCard,LinkedItemsCard,ThreadPane}.tsx`, `routes/conversations.$id.templates.ts`.

## Global Constraints
- **Visibility (SP-25):**
  - The customer thread includes only conversations the viewer can see (`conversationScope`).
  - Events come from records the viewer can view: `tickets.view` for ticket events, `bookings.view` for booking events.
  - Every new handler that reads conversation data injects `@CurrentViewer` and is listed in the viewer-coverage spec.
  - Every route is added to `permission-map.ts`.
- **Undo stage move:**
  - Only the most recent `stage_changed` activity on the ticket.
  - Within 10 minutes of it.
  - Made by the same user, unless they hold `tickets.manage`.
  - The ticket must still be in that `toStage`.
  - The undo is itself a move back, logged as an activity, and it respects `agentCanMove`. On failure: 409 `tickets.undo_expired` or `tickets.undo_not_latest`.
- **Saved replies:**
  - Manage requires `conversations.manage`; use requires `conversations.view`.
  - `shortcut` is `[a-z0-9_-]{1,32}` and unique per workspace (409 `saved_replies.shortcut_exists`).
  - `body` up to 4000 characters, with optional `bodyAr`.
  - The composer inserts the body matching the UI language, falling back to the other one.
- **Template header:**
  - Header types IMAGE, VIDEO and DOCUMENT use media from the library: workspace-verified, with a mime type matching the header type.
  - TEXT headers take `{{n}}` params.
  - The send payload follows the existing WhatsApp/Zernio template send.
  - Preview renders client-side from the template components.
- **Reactions:** an emoji string (≤ 16 chars). An empty string removes the reaction. Only the latest reaction per message is kept.
- **Copy and layout:** every user-facing string goes through `tx("English","العربية")` with real Arabic; logical CSS; `dir="auto"` on message and reply text.
- **Migration:** hand-written `backend/prisma/migrations/20261111120000_inbox_enrichments/migration.sql`, additive and idempotent, safe for the deployed code.
- **Tests:**
  - backend: `npx jest src/conversations src/contacts src/integrations src/tickets src/saved-replies src/permissions` plus tsc
  - frontend: `npx vitest run` plus `npm run typecheck`
- **Commits:** selective `git add`; trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus
1. **Stitched thread across 3 conversations on 2 channels:**
   - correct chronological order;
   - seams at conversation boundaries;
   - the cursor loads older items without gaps or duplicates;
   - hidden conversations are excluded for assigned-only viewers.
2. **Undo:**
   - only the latest move, within 10 minutes, by its author or a manager, and only while the ticket is still in that stage;
   - otherwise 409 with a specific key;
   - the undo writes an activity and fires the normal move side effects (realtime, workflows).
3. **Reactions:** a reaction webhook for a known `metaMessageId` updates exactly that message in that workspace. An unknown id is ignored. An empty emoji removes the reaction.
4. **Saved reply shortcuts** are unique per workspace under concurrent creates: unique index plus P2002 → 409.
5. **Template header media from another workspace** returns 404. A mime type that doesn't match the header type returns 400 `templates.header_media_mismatch`.

---

### Task 1: Backend — schema, thread endpoint, events, undo, reactions, saved replies, header send
**Files:**
- Schema and migration.
- Create `backend/src/contacts/customer-thread.service.ts` with its spec. Route `GET /contacts/:id/thread`.
- `backend/src/tickets/tickets.service.ts`: `undoLastMove(workspaceId, ticketId, viewer)`, plus route `POST /tickets/:id/undo-stage`.
- Reaction handling in `backend/src/integrations/zernio.service.ts` and the Meta WhatsApp webhook service, with specs.
- `backend/src/saved-replies/*`: CRUD module with spec.
- Extend the WhatsApp template send DTO and service with header params and header media, with a spec.
- `backend/src/conversations`: expose `topics`/`painPoints` in the conversation payload.
- Translation: `POST /conversations/:id/summary/translate {lang}` only if the l agent supports translation. Otherwise skip the route and document why.
- Permission map and viewer-coverage spec.

**Produces:**
- `GET /contacts/:id/thread?before&limit=50` returns `{ items: ThreadItem[], nextBefore? }`.
  - `ThreadItem = {type:"message", conversationId, channel, message} | {type:"seam", conversationId, channel, startedAt} | {type:"event", kind:"stage_changed"|"ticket_created"|"ticket_won"|"ticket_lost"|"booking_created"|"booking_status"|"activity_done", at, ticketId?, appointmentId?, data, undoable?: boolean}`.
  - The cursor follows the SP-04 timeline pattern (`ISO|type|id`).
- `POST /tickets/:id/undo-stage` returns the ticket.
- Saved replies: `GET/POST/PATCH/DELETE /saved-replies`.
- WhatsApp template send accepts `{ header?: { mediaId?: string; params?: string[] } }`.

- [ ] Failing tests for every Review Focus item, implementation, then GREEN. Run the full jest suite once.
- [ ] Commit `feat(inbox): customer thread, thread events with undo, reactions, saved replies, template headers`.

### Task 2: Frontend
**Files:**
- `src/screens/inbox/thread/{CustomerThread.tsx, SegmentSeam.tsx, ThreadEvent.tsx, threadModel.ts}` with `threadModel.test.ts`.
- `src/screens/inbox/{SavedRepliesPicker.tsx, SavedRepliesManager.tsx, LinkedItemsCard.tsx, TopicsCard.tsx}`.
- Template header step in the template picker in `Inbox.tsx`, or an extracted `TemplateSendDialog.tsx`. Prefer extracting it, since `Inbox.tsx` is very large.
- `Inbox.tsx` wiring:
  - a toggle between "This conversation" and "All conversations" in the thread header, stored in the hash as `?tv=`;
  - reactions on bubbles;
  - the saved replies picker replaces the three hardcoded chips at `Inbox.tsx:~1510`, and `/` in the composer opens it;
  - the linked items card and topics card in the details panel.
- Settings: a "Saved replies" manager section, gated on `conversations.manage`.

**Produces:**
- `threadModel.ts`:
  - `mergePage(prev, next)` deduplicates by type and id and keeps order;
  - `seamLabel(channel, lang)`;
  - `eventText(event, tx)`.

  All three are tested.
- The undo button appears on undoable stage events. It is disabled after the 10-minute window (computed client-side and enforced by the server). On a 409 it shows the key's message.

- [ ] Failing vitest tests, implementation until they pass, then build the components. typecheck and vitest must be clean.
- [ ] Commit `feat(inbox): customer thread, events with undo, reactions, saved replies, template header step`.

### Task 3: Verification
Apply the migration once it's safe. Live checks:
- a stitched thread across channels;
- undo within and after the window;
- a reaction webhook through a replayed payload;
- saved replies;
- a template with an image header;
- the Arabic UI.

Revert any test data, then tick SP-31.
