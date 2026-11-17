import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import type { Permission } from "./catalog";

export type RouteRule = Permission | "public" | "authenticated";

function joinPath(base: string, sub: string): string {
  const p = `/${base}/${sub}`.replace(/\/+/g, "/");
  return p.length > 1 ? p.replace(/\/$/, "") : p;
}

function asList(v: unknown): string[] {
  if (v === undefined || v === null) return [""];
  return Array.isArray(v) ? v.map(String) : [String(v)];
}

/** "METHOD /path" keys for one handler (controller path + handler path,
 *  without the global "api" prefix). Empty if the function is not a route. */
export function routeKeysFor(controller: Function, handler: Function): string[] {
  const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
  const sub = Reflect.getMetadata(PATH_METADATA, handler) as unknown;
  if (method === undefined || sub === undefined) return [];
  const verb = RequestMethod[method];
  const keys: string[] = [];
  for (const base of asList(Reflect.getMetadata(PATH_METADATA, controller)))
    for (const s of asList(sub)) keys.push(`${verb} ${joinPath(base, s)}`);
  return keys;
}

/** Every route declared on a controller class. */
export function routesOf(controller: Function): { key: string; controller: Function; handler: Function }[] {
  const out: { key: string; controller: Function; handler: Function }[] = [];
  const seen = new Set<string>();
  for (let proto = controller.prototype; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === "constructor" || seen.has(name)) continue;
      seen.add(name);
      const desc = Object.getOwnPropertyDescriptor(proto, name);
      const fn = desc?.value;
      if (typeof fn !== "function") continue;
      for (const key of routeKeysFor(controller, fn)) out.push({ key, controller, handler: fn });
    }
  }
  return out;
}

/**
 * Route → permission for every route in every controller.
 *  - "public": no workspace user (webhooks with their own signature guards,
 *    SSO, login, health, public media). PermissionGuard is a no-op there.
 *  - "authenticated": any member of the JWT workspace, no specific
 *    permission (notifications, /me/permissions, search — results are
 *    visibility-filtered in the service). Own-account routes listed by
 *    membershipExempt() (/auth/*, /admin/*, workspace list/create) work
 *    even without membership, e.g. to switch away after being removed.
 *  - otherwise the `resource.action` the member's role must grant.
 * There is no default: permission-map.spec.ts fails for an unmapped route,
 * and PermissionGuard fails closed (403) if one slips through at runtime.
 */
const MEMBERSHIP_EXEMPT = new Set(["GET /workspaces", "POST /workspaces"]);

/** "authenticated" routes that must keep working for a user who is not (or
 *  no longer) a member of the JWT workspace: /auth/* (me, workspaces,
 *  switch-workspace, change-password), /admin/* (SuperAdminGuard decides),
 *  and the workspace list/create. */
export function membershipExempt(key: string): boolean {
  const path = key.slice(key.indexOf(" ") + 1);
  return path.startsWith("/auth/") || path.startsWith("/admin/") || MEMBERSHIP_EXEMPT.has(key);
}

export const ROUTE_PERMISSIONS: Record<string, RouteRule> = {
  // ── Own account / any signed-in user ──────────────────────────────────
  "GET /auth/me": "authenticated",
  "PATCH /auth/me": "authenticated",
  "GET /auth/workspaces": "authenticated",
  "POST /auth/switch-workspace": "authenticated",
  "POST /auth/change-password": "authenticated",
  // SP-26 Task 2: two-step verification for the signed-in user.
  "POST /auth/2fa/setup": "authenticated",
  "POST /auth/2fa/enable": "authenticated",
  "POST /auth/2fa/disable": "authenticated",
  "POST /auth/2fa/recovery-codes": "authenticated",
  // SP-26: the invitee's own invitations and activation by slug.
  "GET /auth/invitations": "authenticated",
  "POST /auth/invitations/accept": "authenticated",
  "GET /auth/workspaces/by-slug/:slug": "authenticated",
  "GET /me/permissions": "authenticated",
  "GET /notifications": "authenticated",
  "GET /notifications/unread-count": "authenticated",
  "POST /notifications/read": "authenticated",
  "GET /notifications/preferences": "authenticated",
  "PUT /notifications/preferences": "authenticated",
  "GET /records/:kind/:id": "authenticated", // per-kind view permission + conversation visibility checked in RecordsService
  "GET /search": "authenticated", // results get visibility-filtered in SearchService (later task)
  "GET /hjz/link": "authenticated", // the caller's own HJZ link
  "POST /hjz/link": "authenticated",
  // Workspace list/create act on the caller's own memberships (membership-
  // exempt); the :id route also checks membership of :id inline.
  "GET /workspaces": "authenticated",
  "POST /workspaces": "authenticated",
  "GET /workspaces/:id": "authenticated",
  // SuperAdminGuard is the gate; super-admins bypass PermissionGuard anyway.
  "GET /admin/workspaces": "authenticated",
  "GET /admin/workspaces/:id": "authenticated",
  "PATCH /admin/workspaces/:id": "authenticated",
  "POST /admin/workspaces/:id/suspend": "authenticated",
  "POST /admin/workspaces/:id/impersonate": "authenticated",
  "POST /admin/provision": "authenticated",
  "GET /admin/users": "authenticated",

  // ── Public: no workspace user (own signature/token guards) ────────────
  "POST /auth/login": "public",
  "POST /auth/register": "public",
  "POST /auth/sso/exchange": "public",
  "POST /auth/sso/kewy": "public",
  "POST /auth/sso/tiremall": "public",
  // SP-26: invitation preview/accept for a signed-out invitee (token-gated, rate-limited).
  "POST /invitations/preview": "public",
  // SP-26 Task 2: password reset and the second login step (rate-limited).
  "POST /auth/password/forgot": "public",
  "POST /auth/password/reset": "public",
  "POST /auth/2fa/verify": "public",
  "POST /invitations/accept": "public",
  "GET /health": "public",
  "POST /ads/webhook/stripe": "public",
  "POST /ai/reply": "public",
  "GET /integrations/facebook/oauth/callback": "public",
  "POST /webhooks/hjz/clients": "public",
  "POST /webhooks/hjz/segments": "public",
  "POST /webhooks/hjz/sales": "public",
  "GET /webhooks/whatsapp": "public",
  "POST /webhooks/whatsapp": "public",
  "POST /webhooks/zernio": "public",
  "POST /webhooks/telegram/:channelId": "public", // TelegramWebhookGuard: secret header
  // SP-19 T3 web chat widget: WidgetRateLimitGuard + WidgetOriginGuard (the loader is static).
  "GET /widget.js": "public",
  "GET /chat/:channelId": "public",
  "GET /widget/:channelId/config": "public",
  "GET /widget/:channelId/messages": "public",
  "POST /widget/:channelId/messages": "public",
  "GET /webhooks/meta": "public",
  "POST /webhooks/meta": "public",
  "POST /webhooks/l/messages": "public",
  "POST /webhooks/tiremall/customers": "public",
  "POST /webhooks/workflows/:workflowId": "public",
  "POST /mcp/v1": "public",
  "GET /media/:id/public": "public",
  "GET /joteck/workspaces": "public",
  "POST /joteck/workspaces": "public",
  "GET /joteck/workspaces/:id": "public",
  "GET /joteck/workspaces/:id/stats": "public",
  "POST /joteck/workspaces/:id/agent-setup": "public",
  "PATCH /joteck/workspaces/:id": "public",
  "POST /joteck/workspaces/:id/billing-state": "public",

  // ── Conversations ─────────────────────────────────────────────────────
  "GET /conversations": "conversations.view",
  "GET /conversations/:id": "conversations.view",
  "POST /conversations": "conversations.create",
  "PATCH /conversations/:id": "conversations.update",
  "POST /conversations/:id/read": "conversations.view", // personal read state; viewers open threads too,
  "DELETE /conversations/:id": "conversations.delete",
  "GET /conversations/:id/messages": "conversations.view",
  "POST /conversations/:id/ai": "conversations.update",
  "POST /conversations/:id/messages": "conversations.create",
  "POST /conversations/:id/send": "conversations.create", // SP-19 transport send (telegram/native); viewer-checked
  "PUT /conversations/:id/labels": "conversations.update",
  "GET /conversation-labels": "conversations.view",
  // SP-15: the inbox Ad source filter's options, and an ad's conversations
  // (ANDed with the viewer's conversation scope).
  "GET /ad-sources": "conversations.view",
  "GET /ad-sources/:id/conversations": "conversations.view",
  // SP-15 Task 2: ad metrics (spend, started, cost) are reports.
  "GET /ad-sources/overview": "reports.view",
  "GET /ad-sources/:id": "reports.view",
  // SP-15 Task 2: Meta Ads connect (ruling 7). The callback is public; its
  // state JWT binds workspace + user and the user's connectors.manage is re-checked.
  "GET /meta-ads/connection": "connectors.view",
  "GET /meta-ads/oauth/start": "connectors.manage",
  "GET /meta-ads/oauth/callback": "public",
  "GET /meta-ads/candidates": "connectors.manage",
  "POST /meta-ads/connection": "connectors.manage",
  "POST /meta-ads/check": "connectors.manage",
  "DELETE /meta-ads/connection": "connectors.manage",
  "GET /saved-replies": "conversations.view",
  "POST /saved-replies": "conversations.manage",
  "PATCH /saved-replies/:id": "conversations.manage",
  "DELETE /saved-replies/:id": "conversations.manage",
  // Agents manage labels inline from the inbox label picker.
  "POST /conversation-labels": "conversations.update",
  "PATCH /conversation-labels/:id": "conversations.update",
  "DELETE /conversation-labels/:id": "conversations.update",
  // Notes live on conversations/contacts/tickets. Edit/delete additionally
  // require being the note's author, or holding conversations.manage
  // (NotesService.assertCanChange), else 403.
  // Activities (SP-04): permission follows the link (contacts.* or tickets.*)
  // and is checked per activity inside ActivitiesService, so "authenticated" here.
  "GET /activities": "authenticated",
  "GET /activities/queue": "authenticated",
  "GET /activities/next-steps": "authenticated",
  "POST /activities": "authenticated",
  "POST /activities/bulk": "authenticated",
  "PATCH /activities/:id": "authenticated",
  "POST /activities/:id/complete": "authenticated",
  "DELETE /activities/:id": "authenticated",
  "GET /notes": "conversations.view",
  "POST /notes": "conversations.create",
  "PATCH /notes/:id": "conversations.update",
  "DELETE /notes/:id": "conversations.update",
  "POST /notes/:id/seen": "conversations.view", // personal read receipt
  // Channel-side messaging (provider threads, comments) is inbox work.
  "POST /integrations/whatsapp/conversations/:conversationId/send": "conversations.create",
  "POST /integrations/whatsapp/conversations/:conversationId/send-template": "conversations.create",
  "GET /integrations/zernio/comments": "conversations.view",
  "POST /integrations/zernio/comments/:id/reply": "conversations.create",
  "POST /integrations/zernio/posts/:postId/comments": "conversations.create",
  "DELETE /integrations/zernio/comments/:id": "conversations.delete",
  "GET /integrations/zernio/conversations": "conversations.view",
  "GET /integrations/zernio/conversations/:id/messages": "conversations.view",
  "POST /integrations/zernio/conversations/:id/send": "conversations.create",
  "POST /integrations/zernio/db-conversations/:id/send": "conversations.create",
  "POST /integrations/zernio/db-conversations/:id/send-template": "conversations.create",
  "GET /integrations/facebook/posts/:postId/comments": "conversations.view",
  "POST /integrations/facebook/comments/:commentId/reply": "conversations.create",
  "DELETE /integrations/facebook/comments/:commentId": "conversations.delete",
  "GET /integrations/facebook/conversations": "conversations.view",
  "GET /integrations/facebook/conversations/:conversationId/messages": "conversations.view",
  "POST /integrations/facebook/conversations/:recipientId/send": "conversations.create",
  "GET /integrations/instagram/conversations": "conversations.view",
  "GET /integrations/instagram/conversations/:conversationId/messages": "conversations.view",
  "POST /integrations/instagram/conversations/by-igsid/:igsid/send": "conversations.create",
  "POST /integrations/instagram/conversations/:conversationId/send": "conversations.create",
  "GET /integrations/instagram/posts/:mediaId/comments": "conversations.view",
  "POST /integrations/instagram/posts/:mediaId/comments": "conversations.create",
  "DELETE /integrations/instagram/comments/:commentId": "conversations.delete",
  // Media library: attachments are sent from the inbox.
  "GET /media": "conversations.view",
  "GET /media/:id/file": "conversations.view",
  "POST /media/upload": "conversations.create",
  "DELETE /media/:id": "conversations.update",
  // SP-17 (ruling 5): details and the agent switch decide what the AI may
  // send to every customer, so they follow knowledge, not conversations.
  "PATCH /media/:id": "knowledge.update",

  // ── Contacts ──────────────────────────────────────────────────────────
  "GET /contacts": "contacts.view",
  "GET /contacts/page": "contacts.view",
  "GET /contacts/ids": "contacts.view",
  // Bulk export is owner/admin only (SP-03 ruling).
  "GET /contacts/export": "contacts.manage",
  "POST /contacts/export": "contacts.manage", // JSON body: large selections
  // op "delete" additionally requires contacts.delete (ContactsController).
  "POST /contacts/bulk": "contacts.update",
  "GET /contacts/stats": "contacts.view",
  "GET /contacts/:id": "contacts.view",
  "GET /contacts/:id/summary": "contacts.view",
  "GET /contacts/:id/timeline": "contacts.view", // messages filtered by conversation scope
  "GET /contacts/:id/thread": "conversations.view", // messages by conversation scope; events by tickets.view / bookings.view
  "GET /contacts/:id/tickets": "contacts.view",
  "GET /contacts/:id/appointments": "contacts.view",
  "POST /contacts": "contacts.create",
  "PATCH /contacts/:id": "contacts.update",
  "DELETE /contacts/:id": "contacts.delete",
  "GET /contacts/:id/fields": "contacts.view",
  "PUT /contacts/:id/fields": "contacts.update",
  // Contacts import (SP-03). preview/run with updateExisting also need
  // contacts.update, audience kind also audiences.create (ImportsService).
  "POST /imports": "contacts.create",
  "GET /imports": "contacts.view",
  "GET /imports/:id": "contacts.view",
  "POST /imports/:id/preview": "contacts.create",
  "POST /imports/:id/run": "contacts.create",
  "POST /imports/:id/cancel": "contacts.create",
  "GET /custom-fields": "contacts.view",
  "GET /custom-fields/:id/delete-preview": "settings.view",
  // Field definitions are workspace settings (were @WorkspaceRoles("owner","admin")).
  "POST /custom-fields": "settings.manage",
  "PATCH /custom-fields/:id": "settings.manage",
  "DELETE /custom-fields/:id": "settings.manage",
  // Tags label contacts; agents tag (and create tags) while working contacts.
  "GET /tags": "contacts.view",
  // SP-16: the smart audiences that name a tag (read before a delete).
  "GET /tags/:id/references": "contacts.view",
  "POST /tags": "contacts.update",
  "POST /tags/assign": "contacts.update",
  "PATCH /tags/:id": "contacts.update",
  "DELETE /tags/:id": "contacts.update",
  "POST /tags/merge": "contacts.update",

  // ── Tickets & pipelines ───────────────────────────────────────────────
  "GET /pipelines": "pipelines.view",
  "GET /pipelines/:id": "pipelines.view",
  "GET /pipelines/:id/lost-reasons": "pipelines.view",
  "POST /pipelines": "pipelines.manage",
  "PUT /pipelines/:id/draft": "pipelines.manage",
  "POST /pipelines/:id/archive": "pipelines.manage",
  "POST /pipelines/:id/unarchive": "pipelines.manage",
  "GET /tickets": "tickets.view",
  "GET /tickets/dashboard/summary": "tickets.view",
  "GET /tickets/:id": "tickets.view",
  "POST /tickets": "tickets.create",
  "POST /tickets/from-conversation/:conversationId": "tickets.create",
  "POST /tickets/bulk": "tickets.update",
  "POST /tickets/:id/reopen": "tickets.update",
  "PATCH /tickets/:id": "tickets.update",
  "POST /tickets/:id/move": "tickets.update",
  "POST /tickets/:id/undo-stage": "tickets.update", // author or tickets.manage, enforced in the service
  "POST /tickets/:id/notes": "tickets.update",
  "DELETE /tickets/:id": "tickets.delete",
  // SP-09: attachments, resolve and booking cards. Customer files also follow
  // conversation visibility in the service; the booking cards also need
  // tickets.view (service).
  "GET /tickets/:id/attachments": "tickets.view",
  "GET /tickets/:id/attachments/candidates": "tickets.update",
  "POST /tickets/:id/attachments": "tickets.update",
  "POST /tickets/:id/attachments/upload": "tickets.update",
  "GET /tickets/:id/attachments/:attId": "tickets.view",
  "DELETE /tickets/:id/attachments/:attId": "tickets.update",
  "POST /tickets/:id/resolve": "tickets.update",
  "GET /tickets/:id/bookings": "bookings.view",

  // ── Bookings ──────────────────────────────────────────────────────────
  "GET /appointments": "bookings.view",
  // SP-10: booking search typeahead (declared before :id) and availability.
  "GET /appointments/search": "bookings.view",
  "GET /bookings/availability": "bookings.view",
  // SP-10: catalog import (ruling 12: bookings.manage; the template download is a read).
  "POST /catalog-imports": "bookings.manage",
  "GET /catalog-imports": "bookings.manage",
  "GET /catalog-imports/templates/:kind": "bookings.view",
  "GET /catalog-imports/:id": "bookings.manage",
  "PATCH /catalog-imports/:id/items": "bookings.manage",
  "POST /catalog-imports/:id/run": "bookings.manage",
  "POST /catalog-imports/:id/cancel": "bookings.manage",
  "GET /appointments/:id": "bookings.view",
  "POST /appointments": "bookings.create",
  "PATCH /appointments/:id": "bookings.update",
  "DELETE /appointments/:id": "bookings.delete",
  // SP-10: the services and staff catalog. Reads need bookings.view; every
  // catalog write needs bookings.manage (ruling 12: agents book, but do not
  // edit the catalog).
  "GET /services": "bookings.view",
  "POST /services": "bookings.manage",
  "GET /services/:id/delete-preview": "bookings.manage",
  "PATCH /services/:id": "bookings.manage",
  "PUT /services/:id/staff": "bookings.manage",
  "DELETE /services/:id": "bookings.manage",
  "POST /services/:id/restore": "bookings.manage",
  "GET /staff": "bookings.view",
  "POST /staff": "bookings.manage",
  "GET /staff/:id/delete-preview": "bookings.manage",
  "PATCH /staff/:id": "bookings.manage",
  "PUT /staff/:id/services": "bookings.manage",
  "DELETE /staff/:id": "bookings.manage",
  "POST /staff/:id/restore": "bookings.manage",

  // ── Audiences (segments) ──────────────────────────────────────────────
  "GET /segments": "audiences.view",
  "POST /segments/preview": "audiences.view", // read-only preview
  "POST /segments": "audiences.create",
  "PATCH /segments/:id": "audiences.update",
  "DELETE /segments/:id": "audiences.delete",
  "POST /segments/:id/members": "audiences.update",
  "DELETE /segments/:id/members/:contactId": "audiences.update",
  "GET /segments/:id/members": "audiences.view",
  // SP-16: audience detail, keyset members, count and manual-group candidates.
  "GET /segments/:id": "audiences.view",
  "GET /segments/:id/contacts": "audiences.view",
  "GET /segments/:id/count": "audiences.view",
  "GET /segments/:id/candidates": "audiences.view",
  "POST /segments/admin/resync-hjz": "audiences.manage",

  // ── Campaigns, social posts, ads ──────────────────────────────────────
  "GET /campaigns": "campaigns.view",
  "GET /campaigns/preview": "campaigns.view",
  // SP-13: sending numbers (no channels.view needed) and the review-step preview.
  "GET /campaigns/senders": "campaigns.view",
  "POST /campaigns/preview": "campaigns.view",
  "GET /campaigns/:id": "campaigns.view",
  "POST /campaigns": "campaigns.create",
  "PATCH /campaigns/:id": "campaigns.update",
  "POST /campaigns/:id/launch": "campaigns.manage",
  "POST /campaigns/:id/cancel": "campaigns.manage",
  "POST /campaigns/:id/refresh": "campaigns.update",
  "DELETE /campaigns/:id": "campaigns.delete",
  // SP-12 (ruling 8): report reads, export and three follow-up routes. None
  // uses campaigns.manage (impersonation-blocked spending). Export is bulk
  // personal data, owner/admin only like SP-03 (service also asserts campaigns.view).
  "GET /campaigns/:id/recipients": "campaigns.view",
  "GET /campaigns/:id/insights": "campaigns.view",
  "GET /campaigns/:id/export": "contacts.manage",
  "POST /campaigns/:id/export": "contacts.manage",
  "POST /campaigns/:id/follow-up/create-group": "audiences.create",
  "POST /campaigns/:id/follow-up/add-to-group": "audiences.update",
  "POST /campaigns/:id/follow-up/tag": "contacts.update",
  "POST /social/publish": "campaigns.create",
  "GET /social/scheduled": "campaigns.view",
  "GET /social/analytics/overview": "reports.view",
  "DELETE /social/scheduled/:id": "campaigns.update", // cancels a scheduled post
  "PATCH /social/scheduled/:id": "campaigns.update",
  "GET /integrations/facebook/posts": "campaigns.view",
  "POST /integrations/facebook/posts": "campaigns.create",
  "DELETE /integrations/facebook/posts/:postId": "campaigns.delete",
  "PATCH /integrations/facebook/posts/:postId": "campaigns.update",
  "GET /integrations/instagram/posts": "campaigns.view",
  "POST /integrations/instagram/posts": "campaigns.create",
  "DELETE /integrations/instagram/posts/:mediaId": "campaigns.delete",
  "PATCH /integrations/instagram/posts/:mediaId": "campaigns.update",
  "GET /integrations/zernio/posts": "campaigns.view",
  "POST /ads/chat": "campaigns.create",
  "GET /ads/chat/sessions": "campaigns.view",
  "GET /ads/chat/sessions/:id": "campaigns.view",
  "GET /ads/prompts": "campaigns.view",
  "GET /ads/wallet": "campaigns.view",
  // Were @WorkspaceRoles("owner","admin").
  "POST /ads/wallet/topup": "billing.update",
  "POST /ads/actions/:id/approve": "campaigns.manage",
  "POST /ads/actions/:id/reject": "campaigns.manage",

  // ── Templates ─────────────────────────────────────────────────────────
  "GET /templates": "templates.view",
  "GET /templates/library": "templates.view",
  "GET /templates/:id": "templates.view",
  "POST /templates": "templates.create",
  "PATCH /templates/:id": "templates.update",
  "DELETE /templates/:id": "templates.delete",
  "POST /templates/:id/duplicate": "templates.create",
  "GET /templates/:id/health": "templates.view", // SP-14: the template on every number (snapshots, no provider call)

  // ── AI agent & knowledge ──────────────────────────────────────────────
  "GET /ai/settings": "agent.view",
  "POST /ai/settings/toggle": "agent.update",
  "PATCH /ai/settings": "agent.update",
  "GET /integrations/l/status": "agent.view",
  "GET /integrations/l/tools": "agent.view",
  "POST /integrations/l/tools": "agent.create",
  "DELETE /integrations/l/tools/:toolId": "agent.delete",
  "POST /integrations/l/tools/:toolId/binding": "agent.update",
  "DELETE /integrations/l/tools/:toolId/binding": "agent.update",
  "GET /ai/knowledge/status": "knowledge.view",
  "GET /ai/knowledge/docs": "knowledge.view",
  "POST /ai/knowledge/docs": "knowledge.create",
  "DELETE /ai/knowledge/docs/:id": "knowledge.delete",
  "POST /ai/knowledge/sync": "knowledge.update",
  "GET /ai/knowledge/sync-enabled": "knowledge.view",
  "POST /ai/knowledge/sync-enabled": "knowledge.update",
  "GET /integrations/l/knowledge": "knowledge.view",
  "POST /integrations/l/knowledge": "knowledge.create",
  "DELETE /integrations/l/knowledge/:documentId": "knowledge.delete",
  // SP-21 knowledge store (Task 2 adds the website routes).
  "GET /knowledge/sources": "knowledge.view",
  "GET /knowledge/sources/:id": "knowledge.view",
  "GET /knowledge/sources/:id/preview": "knowledge.view",
  "GET /knowledge/sources/:id/pages": "knowledge.view",
  "GET /knowledge/sources/:id/file": "knowledge.view",
  "GET /knowledge/templates/:kind": "knowledge.view",
  "PUT /knowledge/content": "knowledge.update",
  "PUT /knowledge/guidelines": "knowledge.update",
  "PATCH /knowledge/faqs/:id": "knowledge.update",
  "POST /knowledge/faqs/reorder": "knowledge.update",
  "POST /knowledge/sources/:id/reprocess": "knowledge.update",
  "POST /knowledge/faqs": "knowledge.create",
  "POST /knowledge/files": "knowledge.create",
  "DELETE /knowledge/sources/:id": "knowledge.delete",
  // SP-21 Task 2: website sources.
  "POST /knowledge/websites/check": "knowledge.create",
  "POST /knowledge/websites": "knowledge.create",
  "PATCH /knowledge/websites/:id": "knowledge.update",
  "POST /knowledge/websites/:id/refresh": "knowledge.update",

  // ── SP-20 agent settings, sandbox and onboarding ──────────────────────
  "GET /agent/settings": "agent.view",
  "PATCH /agent/settings": "agent.update",
  "POST /agent/settings/resync": "agent.update",
  // SP-22: the skills gallery.
  "GET /skills": "agent.view",
  "POST /skills/:key/install": "agent.update",
  "PATCH /skills/:key": "agent.update",
  "POST /skills/:key/update": "agent.update",
  "POST /skills/:key/retry": "agent.update",
  "DELETE /skills/:key": "agent.delete",
  // A sandbox turn costs money (ruling 9): owners and admins by default.
  "GET /agent/sandbox": "agent.update",
  "POST /agent/sandbox/messages": "agent.update",
  "DELETE /agent/sandbox": "agent.update",
  // Every member may ask whether onboarding is shown; driving it is settings.update
  // (Apply also checks knowledge.* and agent.update for the parts it writes).
  "GET /onboarding": "authenticated",
  "PATCH /onboarding": "settings.update",
  "POST /onboarding/website": "settings.update",
  "POST /onboarding/learn": "settings.update",
  "POST /onboarding/learn/apply": "settings.update",

  // ── SP-18 copilot ("Ask Kewy") ────────────────────────────────────────
  // Every member may chat (ruling 2); each tool checks its own permission as
  // the member, so the copilot shows only what the member could open in the UI.
  // Sessions are the member's own (404 otherwise). Task 2 adds actions and attachments.
  "POST /copilot/stream": "authenticated",
  "GET /copilot/status": "authenticated",
  "GET /copilot/sessions": "authenticated",
  "GET /copilot/sessions/:id": "authenticated",
  "DELETE /copilot/sessions/:id": "authenticated",
  // Task 2: cards (the proposing member only; the tool's permission is re-checked at approval) and attachments.
  "POST /copilot/actions/:id/approve": "authenticated",
  "POST /copilot/actions/:id/decline": "authenticated",
  "POST /copilot/attachments": "authenticated",
  "DELETE /copilot/attachments/:id": "authenticated",

  // ── Connectors (MCP servers bound to the agent) ───────────────────────
  "GET /integrations/l/mcp-servers": "connectors.view",
  "POST /integrations/l/mcp-servers": "connectors.create",
  "DELETE /integrations/l/mcp-servers/:serverId": "connectors.delete",
  "POST /integrations/l/mcp-servers/:serverId/binding": "connectors.update",
  "DELETE /integrations/l/mcp-servers/:serverId/binding": "connectors.update",
  "POST /integrations/l/mcp-servers/:serverId/test": "connectors.update",

  // ── API keys (the inbound MCP token) ──────────────────────────────────
  "GET /integrations/mcp/token/status": "api_keys.view",
  "POST /integrations/mcp/token": "api_keys.create",
  "DELETE /integrations/mcp/token": "api_keys.delete",

  // ── Channels ──────────────────────────────────────────────────────────
  "GET /integrations/facebook/oauth/start": "channels.create",
  "GET /integrations/facebook/status": "channels.view",
  "POST /integrations/facebook/connect": "channels.create",
  "DELETE /integrations/facebook/disconnect": "channels.delete",
  "GET /integrations/facebook/pages": "channels.view",
  "POST /integrations/facebook/resubscribe-webhook": "channels.update",
  "POST /integrations/facebook/select-page": "channels.update",
  "GET /integrations/instagram/status": "channels.view",
  "POST /integrations/instagram/sync": "channels.update",
  "GET /integrations/whatsapp/status": "channels.view",
  "POST /integrations/whatsapp/connect": "channels.create",
  "POST /integrations/whatsapp/connect-by-token": "channels.create",
  "POST /integrations/whatsapp/oauth/exchange": "channels.create",
  "DELETE /integrations/whatsapp/disconnect": "channels.delete",
  "POST /integrations/whatsapp/test-send": "channels.update",
  "GET /integrations/zernio/status": "channels.view",
  "GET /integrations/zernio/connect/:platform": "channels.create", // mints a connect link
  "POST /integrations/zernio/sync": "channels.update",
  "GET /integrations/zernio/whatsapp/numbers": "channels.view",
  "POST /integrations/zernio/backfill": "channels.update",
  "DELETE /integrations/zernio/:platform": "channels.delete",
  // SP-19 channels hub
  "GET /channels": "channels.view",
  "GET /channels/limits": "channels.view",
  "GET /channels/:id": "channels.view",
  "POST /channels": "channels.create", // web chat only
  "PATCH /channels/:id": "channels.update",
  "POST /channels/sync": "channels.update",
  "POST /channels/:id/reconnect": "channels.update", // T2: Telegram re-registers its webhook
  "POST /channels/:id/health/check": "channels.update", // SP-14 R4: spends provider budget
  "GET /channels/:id/templates": "templates.view", // SP-14 R11(a): the number's template snapshot, read-only
  "POST /channels/telegram": "channels.create",
  "DELETE /channels/:id": "channels.delete", // soft disconnect
  // SP-19 T4: WhatsApp embedded signup, manual multi-number, landline numbers
  "GET /channels/whatsapp/embedded-signup/config": "channels.view", // `missing` only for channels.update
  "POST /channels/whatsapp/embedded-signup": "channels.create",
  "POST /channels/whatsapp/manual": "channels.create",
  "POST /channels/:id/landline/number": "channels.update",
  "POST /channels/:id/landline/request-code": "channels.update",
  "POST /channels/:id/landline/verify": "channels.update",
  "POST /channels/:id/landline/register": "channels.update",

  // ── Members & workspace settings ──────────────────────────────────────
  "GET /roles": "roles.view",
  "POST /roles": "roles.create",
  "PATCH /roles/:id": "roles.update",
  "DELETE /roles/:id": "roles.delete",
  "GET /team": "members.view",
  "GET /workspaces/:id/members": "members.view",
  "POST /workspaces/:id/members": "members.create",
  "POST /workspaces/:id/invite": "members.create",
  "PATCH /workspaces/:id/members/:userId": "members.update",
  "PATCH /workspaces/:id/members/:userId/password": "members.update",
  "DELETE /workspaces/:id/members/:userId": "members.delete",
  // SP-26: email invitations, handover on removal and the audit log (ruling 8).
  "GET /workspaces/:id/invitations": "members.view",
  "POST /workspaces/:id/invitations": "members.create",
  "POST /workspaces/:id/invitations/:invId/resend": "members.create",
  "DELETE /workspaces/:id/invitations/:invId": "members.delete",
  "GET /workspaces/:id/members/:userId/open-work": "members.delete",
  "POST /workspaces/:id/members/:userId/handover": "members.update",
  "GET /workspaces/:id/audit": "members.manage",
  "POST /workspaces/:id/members/:userId/2fa/reset": "members.manage",
  "PATCH /workspaces/:id": "settings.update",
  // Automations (own resource; run/test endpoints are updates).
  "GET /workflows": "workflows.view",
  "GET /workflows/:id": "workflows.view",
  "POST /workflows": "workflows.create",
  "PATCH /workflows/:id": "workflows.update",
  "DELETE /workflows/:id": "workflows.delete",
  "POST /workflows/:id/activate": "workflows.update",
  "POST /workflows/:id/deactivate": "workflows.update",
  "POST /workflows/:id/test": "workflows.update",
  "GET /workflows/:id/runs": "workflows.view",
  "GET /workflows/:id/runs/:runId": "workflows.view",
  // SP-24: Automatic messages (a focused view over system workflows).
  "GET /lifecycle": "workflows.view",
  "POST /lifecycle/:key/setup": "workflows.create",
  "PATCH /lifecycle/:key": "workflows.update",
  // The same permission as GET /templates, which already writes the reconcile.
  "POST /lifecycle/sync": "templates.view",

  // ── Reports ───────────────────────────────────────────────────────────
  "GET /dashboard/summary": "reports.view",
  // SP-11: support insights, computed under the viewer's conversation scope.
  "GET /insights/support": "reports.view",
  // SP-11: sales insights; every section also needs tickets.view (else forbidden).
  "GET /insights/sales": "reports.view",
  // SP-11: the working home; every section is filtered in the service by the
  // member's permissions and conversation scope.
  "GET /home": "authenticated",
  "POST /home/seen": "authenticated",
  "POST /home/day1/dismiss": "authenticated",
};
