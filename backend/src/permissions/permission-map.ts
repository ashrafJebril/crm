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
  "GET /me/permissions": "authenticated",
  "GET /notifications": "authenticated",
  "GET /notifications/unread-count": "authenticated",
  "POST /notifications/read": "authenticated",
  "GET /notifications/preferences": "authenticated",
  "PUT /notifications/preferences": "authenticated",
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
  "PUT /conversations/:id/labels": "conversations.update",
  "GET /conversation-labels": "conversations.view",
  // Agents create labels inline from the inbox label picker.
  "POST /conversation-labels": "conversations.update",
  "PATCH /conversation-labels/:id": "conversations.manage",
  "DELETE /conversation-labels/:id": "conversations.manage",
  // Notes live on conversations/contacts/tickets; edit/delete stay
  // author-checked in NotesService.
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
  "DELETE /media/:id": "conversations.delete",

  // ── Contacts ──────────────────────────────────────────────────────────
  "GET /contacts": "contacts.view",
  "GET /contacts/page": "contacts.view",
  "GET /contacts/ids": "contacts.view",
  // op "delete" additionally requires contacts.delete (ContactsController).
  "POST /contacts/bulk": "contacts.update",
  "GET /contacts/stats": "contacts.view",
  "GET /contacts/:id": "contacts.view",
  "GET /contacts/:id/summary": "contacts.view",
  "GET /contacts/:id/tickets": "contacts.view",
  "GET /contacts/:id/appointments": "contacts.view",
  "POST /contacts": "contacts.create",
  "PATCH /contacts/:id": "contacts.update",
  "DELETE /contacts/:id": "contacts.delete",
  "GET /contacts/:id/fields": "contacts.view",
  "PUT /contacts/:id/fields": "contacts.update",
  "GET /custom-fields": "contacts.view",
  "GET /custom-fields/:id/delete-preview": "settings.view",
  // Field definitions are workspace settings (were @WorkspaceRoles("owner","admin")).
  "POST /custom-fields": "settings.manage",
  "PATCH /custom-fields/:id": "settings.manage",
  "DELETE /custom-fields/:id": "settings.manage",
  // Tags label contacts; agents tag (and create tags) while working contacts.
  "GET /tags": "contacts.view",
  "POST /tags": "contacts.update",
  "POST /tags/assign": "contacts.update",
  "PATCH /tags/:id": "contacts.update",
  "DELETE /tags/:id": "contacts.delete",
  "POST /tags/merge": "contacts.manage",

  // ── Tickets & pipelines ───────────────────────────────────────────────
  "GET /pipelines": "pipelines.view",
  "GET /pipelines/:id": "pipelines.view",
  "GET /tickets": "tickets.view",
  "GET /tickets/dashboard/summary": "tickets.view",
  "GET /tickets/:id": "tickets.view",
  "POST /tickets": "tickets.create",
  "POST /tickets/from-conversation/:conversationId": "tickets.create",
  "PATCH /tickets/:id": "tickets.update",
  "POST /tickets/:id/move": "tickets.update",
  "POST /tickets/:id/notes": "tickets.update",
  "DELETE /tickets/:id": "tickets.delete",

  // ── Bookings ──────────────────────────────────────────────────────────
  "GET /appointments": "bookings.view",
  "GET /appointments/:id": "bookings.view",
  "POST /appointments": "bookings.create",
  "PATCH /appointments/:id": "bookings.update",
  "DELETE /appointments/:id": "bookings.delete",

  // ── Audiences (segments) ──────────────────────────────────────────────
  "GET /segments": "audiences.view",
  "POST /segments/preview": "audiences.view", // read-only preview
  "POST /segments": "audiences.create",
  "PATCH /segments/:id": "audiences.update",
  "DELETE /segments/:id": "audiences.delete",
  "POST /segments/:id/members": "audiences.update",
  "DELETE /segments/:id/members/:contactId": "audiences.update",
  "GET /segments/:id/members": "audiences.view",
  "POST /segments/admin/resync-hjz": "audiences.manage",

  // ── Campaigns, social posts, ads ──────────────────────────────────────
  "GET /campaigns": "campaigns.view",
  "GET /campaigns/preview": "campaigns.view",
  "GET /campaigns/:id": "campaigns.view",
  "POST /campaigns": "campaigns.create",
  "PATCH /campaigns/:id": "campaigns.update",
  "POST /campaigns/:id/launch": "campaigns.manage",
  "POST /campaigns/:id/cancel": "campaigns.manage",
  "POST /campaigns/:id/refresh": "campaigns.update",
  "DELETE /campaigns/:id": "campaigns.delete",
  "POST /social/publish": "campaigns.create",
  "GET /social/scheduled": "campaigns.view",
  "GET /social/analytics/overview": "reports.view",
  "DELETE /social/scheduled/:id": "campaigns.delete",
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

  // ── Reports ───────────────────────────────────────────────────────────
  "GET /dashboard/summary": "reports.view",
};
