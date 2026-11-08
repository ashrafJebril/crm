import "reflect-metadata";
import { ROUTE_ARGS_METADATA } from "@nestjs/common/constants";
import { CurrentViewer } from "../common/current-workspace.decorator";
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

/**
 * Fail-open guard: every member-facing handler that reads conversations,
 * messages or conversation notes must receive the requesting viewer, or an
 * assigned-only member would silently see everything through it. A new handler
 * that forgets @CurrentViewer() must be added here AND wired, or CI fails.
 */
function viewerFactory(): unknown {
  class Probe {
    h(@CurrentViewer() _v: unknown) {}
  }
  const meta = Reflect.getMetadata(ROUTE_ARGS_METADATA, Probe, "h");
  return Object.values<any>(meta)[0].factory;
}

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
];

describe("every conversation-reading handler injects @CurrentViewer()", () => {
  const factory = viewerFactory();
  for (const [name, ctrl, methods] of HANDLERS) {
    for (const m of methods) {
      it(`${name}.${m}`, () => {
        expect(typeof (ctrl.prototype as any)[m]).toBe("function");
        const meta = Reflect.getMetadata(ROUTE_ARGS_METADATA, ctrl, m) ?? {};
        expect(Object.values<any>(meta).some((a) => a.factory === factory)).toBe(true);
      });
    }
  }
});
