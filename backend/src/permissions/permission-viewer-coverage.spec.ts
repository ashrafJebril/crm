import "reflect-metadata";
import * as fs from "fs";
import * as path from "path";
import { MODULE_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from "@nestjs/common/constants";
import { CurrentViewer } from "../common/current-workspace.decorator";
import { ROUTE_PERMISSIONS, routesOf } from "./permission-map";
import { ConversationsController } from "../conversations/conversations.controller";
import { ConversationLabelsController } from "../conversations/conversation-labels.controller";
import { NotesController } from "../notes/notes.controller";
import { SearchController } from "../search/search.controller";
import { DashboardController } from "../dashboard/dashboard.module";
import { ContactsController } from "../contacts/contacts.controller";
import { TicketsController } from "../tickets/tickets.controller";
import { WhatsAppController } from "../integrations/whatsapp.controller";
import { ZernioController } from "../integrations/zernio.controller";
import { FacebookController } from "../integrations/facebook.controller";
import { InstagramController } from "../integrations/instagram.controller";
import { WorkflowsController } from "../workflows/workflows.controller";
import { MediaController } from "../media/media.controller";

// Some modules read secrets at import time (JwtModule.register in AuthModule).
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-permission-viewer-coverage-spec";

/**
 * Fail-open guard: every member-facing handler that reads conversations,
 * messages or conversation-linked data must receive the requesting viewer, or
 * an assigned-only member would silently see everything through it.
 *
 * Derived: every route whose permission-map entry starts with
 * "conversations." must inject @CurrentViewer(), unless it is listed in
 * ALLOWLIST with a reason. HANDLERS adds handlers mapped to other
 * permissions that still expose conversation data.
 */
function viewerFactory(): unknown {
  class Probe {
    h(@CurrentViewer() _v: unknown) {}
  }
  const meta = Reflect.getMetadata(ROUTE_ARGS_METADATA, Probe, "h");
  return Object.values<any>(meta)[0].factory;
}

function injectsViewer(ctrl: Function, method: string, factory: unknown): boolean {
  const meta = Reflect.getMetadata(ROUTE_ARGS_METADATA, ctrl, method) ?? {};
  return Object.values<any>(meta).some((a) => a.factory === factory);
}

/** conversations.* routes that need no viewer, with the reason. */
const ALLOWLIST: Record<string, string> = {
  "POST /conversations": "creates a new conversation; reads no existing one",
  "GET /conversation-labels": "label definitions only; no conversation data",
  "POST /conversation-labels": "creates a label definition",
  "PATCH /conversation-labels/:id": "edits a label definition",
  "DELETE /conversation-labels/:id": "deletes a label definition (links cascade)",
  "POST /media/upload": "stores the caller's own upload; reads no conversation",
  "GET /integrations/zernio/comments": "public post comments, not conversations",
  "POST /integrations/zernio/comments/:id/reply": "public post comment reply",
  "POST /integrations/zernio/posts/:postId/comments": "public post comment",
  "DELETE /integrations/zernio/comments/:id": "public post comment",
  "GET /integrations/facebook/posts/:postId/comments": "public post comments",
  "POST /integrations/facebook/comments/:commentId/reply": "public post comment reply",
  "DELETE /integrations/facebook/comments/:commentId": "public post comment",
  "GET /integrations/instagram/posts/:mediaId/comments": "public post comments",
  "POST /integrations/instagram/posts/:mediaId/comments": "public post comment",
  "DELETE /integrations/instagram/comments/:commentId": "public post comment",
};

const HANDLERS: Array<[string, new (...a: any[]) => unknown, string[]]> = [
  ["conversations", ConversationsController, ["list", "get", "update", "markRead", "remove", "messages", "setAi", "send"]],
  ["conversation-labels", ConversationLabelsController, ["setLabels"]],
  ["notes", NotesController, ["list", "create", "update", "seen", "remove"]],
  ["search", SearchController, ["search"]],
  ["dashboard", DashboardController, ["summary"]],
  ["contacts", ContactsController, ["summary"]],
  ["tickets", TicketsController, ["createTicket", "createFromConversation"]],
  ["whatsapp", WhatsAppController, ["sendInConversation", "sendTemplateInConversation"]],
  ["zernio", ZernioController, ["conversations", "messages", "send", "sendInDbConversation", "sendTemplateInDbConversation"]],
  ["facebook", FacebookController, ["listConversations", "listMessagesInConversation", "sendDirectMessage"]],
  ["instagram", InstagramController, ["listConversations", "listMessages", "sendDirectMessage", "send"]],
  ["workflows", WorkflowsController, ["listRuns", "getRun"]],
  ["media", MediaController, ["list", "serve", "remove"]],
];

const SRC = path.resolve(__dirname, "..");

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts") && !e.name.endsWith(".d.ts") ? [p] : [];
  });
}

/** Every controller class in src (same scan as permission-map.spec.ts). */
function collectControllers(): Set<Function> {
  const classes = new Set<Function>();
  for (const f of walk(SRC)) {
    const text = fs.readFileSync(f, "utf8");
    if (!/@Controller\(/.test(text) && !/@Module\(/.test(text)) continue;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(f) as Record<string, unknown>;
    for (const v of Object.values(mod)) {
      if (typeof v !== "function") continue;
      if (Reflect.getMetadata(PATH_METADATA, v) !== undefined) classes.add(v);
      for (const c of (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, v) as Function[] | undefined) ?? []) classes.add(c);
    }
  }
  return classes;
}

describe("every conversation-reading handler injects @CurrentViewer()", () => {
  const factory = viewerFactory();

  describe("explicit list", () => {
    for (const [name, ctrl, methods] of HANDLERS) {
      for (const m of methods) {
        it(`${name}.${m}`, () => {
          expect(typeof (ctrl.prototype as any)[m]).toBe("function");
          expect(injectsViewer(ctrl, m, factory)).toBe(true);
        });
      }
    }
  });

  describe("derived from the permission map (conversations.*)", () => {
    const routes = [...collectControllers()].flatMap((c) => routesOf(c));
    const conv = routes.filter((r) => String(ROUTE_PERMISSIONS[r.key] ?? "").startsWith("conversations."));

    it("finds the conversation routes", () => {
      expect(conv.length).toBeGreaterThan(30);
    });

    it("each injects the viewer or is allowlisted with a reason", () => {
      const missing = conv
        .filter((r) => !(r.key in ALLOWLIST))
        .filter((r) => !injectsViewer(r.controller, r.handler.name, factory))
        .map((r) => r.key);
      expect(missing).toEqual([]);
    });

    it("the allowlist only names real conversations.* routes", () => {
      const keys = new Set(conv.map((r) => r.key));
      expect(Object.keys(ALLOWLIST).filter((k) => !keys.has(k))).toEqual([]);
      for (const reason of Object.values(ALLOWLIST)) expect(reason.length).toBeGreaterThan(5);
    });
  });
});
