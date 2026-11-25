/**
 * SP-18: the first tool set (read part). `summarize_insights` is registered
 * only when the SP-11 module is present, `search_knowledge` only with SP-21.
 */
import { CopilotToolRegistry } from "./registry";
import type { ReadToolDeps } from "./deps";
import { contactTools } from "./contacts.tool";
import { conversationTools } from "./conversations.tool";
import { ticketTools } from "./tickets.tool";
import { bookingTools } from "./bookings.tool";
import { campaignTools } from "./campaigns.tool";
import { knowledgeTools } from "./knowledge.tool";
import { insightsTools } from "./insights.tool";
import { draftReplyTools } from "./draft-reply.tool";
import type { WriteToolDeps } from "./write-deps";
import { writeTools } from "./write-tools";

export function readTools(deps: ReadToolDeps) {
  return [
    ...contactTools(deps),
    ...conversationTools(deps),
    ...ticketTools(deps),
    ...bookingTools(deps),
    ...campaignTools(deps),
    ...knowledgeTools(deps),
    ...insightsTools(deps),
    ...draftReplyTools(deps),
  ];
}

export function buildReadRegistry(deps: ReadToolDeps): CopilotToolRegistry {
  return new CopilotToolRegistry(readTools(deps));
}

/** The full registry: the read tools and, with their deps, the write tools (Task 2). */
export function buildRegistry(read: ReadToolDeps, write?: WriteToolDeps): CopilotToolRegistry {
  return new CopilotToolRegistry([...readTools(read), ...(write ? writeTools(write) : [])]);
}
