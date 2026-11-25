/**
 * SP-18 page context (pure): the current route and hash → the page key and
 * the ids the copilot may re-read as the member. Never numbers computed in
 * the browser: the server recomputes everything (ruling 11).
 */
import { getHashParam } from "@/lib/hashState";
import { parseRecordParam } from "@/lib/recordParam";
import { isOpaqueThreadId } from "@/lib/recordLink";
import { parseInsightsParams } from "@/screens/insights/insightsParams";
import type { CopilotPageContext, CopilotPageKey, RouteId } from "@/lib/types";

const ROUTE_PAGE: Partial<Record<RouteId, CopilotPageKey>> = {
  dashboard: "dashboard",
  inbox: "inbox",
  contacts: "contacts",
  pipeline: "pipeline",
  calendar: "calendar",
  followups: "followups",
  campaigns: "campaigns",
  agent: "agent",
};
const RECORD_PAGE: Record<string, CopilotPageKey> = {
  contact: "contact",
  conversation: "conversation",
  ticket: "ticket",
  booking: "booking",
  campaign: "campaign",
};
const ID = /^[A-Za-z0-9_:-]{1,64}$/;

export function pageContextOf(route: RouteId, hash: string): CopilotPageContext {
  // The universal record sheet wins: it is what the member is looking at.
  const rec = parseRecordParam(hash);
  if (rec && ID.test(rec.id) && !(rec.kind === "conversation" && isOpaqueThreadId(rec.id))) {
    return { page: RECORD_PAGE[rec.kind], recordKind: rec.kind, recordId: rec.id };
  }
  const open = getHashParam(hash, "open");
  if (route === "inbox" && open && ID.test(open) && !isOpaqueThreadId(open)) {
    return { page: "conversation", recordKind: "conversation", recordId: open };
  }
  if (route === "pipeline" && open && ID.test(open)) return { page: "ticket", recordKind: "ticket", recordId: open };
  if (route === "analytics") {
    const p = parseInsightsParams(hash);
    if (p.tab === "support") return { page: "insights_support", ...(p.from && p.to ? { from: p.from, to: p.to } : {}), ...(p.channel ? { channelId: p.channel } : {}) };
    if (p.tab === "sales") return { page: "insights_sales", ...(p.from && p.to ? { from: p.from, to: p.to } : {}), ...(p.pipeline ? { pipelineId: p.pipeline } : {}) };
    return { page: "other" };
  }
  return { page: ROUTE_PAGE[route] ?? "other" };
}
