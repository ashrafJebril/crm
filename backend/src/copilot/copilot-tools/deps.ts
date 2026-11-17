/**
 * SP-18: what the read tools need. All of it acts as the member: the
 * RecordsService checks (canOpenRecord), PermissionService scopes and
 * SearchService gating are the same ones the UI uses.
 */
import type { PrismaService } from "../../prisma/prisma.service";
import type { PermissionService } from "../../permissions/permission.service";
import type { RecordsService, RecordSummary } from "../../records/records.service";
import type { SearchService } from "../../search/search.service";
import type { TicketsService } from "../../tickets/tickets.service";
import type { BookingsService } from "../../bookings/bookings.service";
import type { KnowledgeSearchService } from "../../knowledge-sources/knowledge-search.service";
import type { InsightsService } from "../../insights/insights.service";
import type { ToolContext } from "./registry";
import { wrapCustomerText, type CustomerWrapped } from "../customer-text";

/** Record kinds whose title, subtitle, fields or links carry text a customer can write (names, ticket titles, messages). */
const CUSTOMER_TEXT_RECORDS: ReadonlySet<string> = new Set(["contact", "conversation", "ticket", "booking"]);

/**
 * A record for the model. Contacts, conversations, tickets and bookings show
 * customer-written text (a contact's name, a ticket made from a message), so
 * everything but the kind and id goes under `customerWritten` and taints the
 * session. A campaign (staff-written) is returned as it is.
 */
export function recordData(ctx: ToolContext, r: RecordSummary): RecordSummary | ({ kind: string; id: string } & CustomerWrapped<Omit<RecordSummary, "kind" | "id">>) {
  if (!CUSTOMER_TEXT_RECORDS.has(r.kind)) return r;
  ctx.taint();
  const { kind, id, ...rest } = r;
  return { kind, id, ...wrapCustomerText(rest) };
}

/** A list whose items carry customer-written text (names, titles): wrapped, and the session tainted when non-empty. */
export function customerList<T>(ctx: ToolContext, key: string, items: T[]): CustomerWrapped<Record<string, T[]>> {
  if (items.length) ctx.taint();
  return wrapCustomerText({ [key]: items });
}

export interface ReadToolDeps {
  prisma: PrismaService;
  perm: PermissionService;
  records: RecordsService;
  search: SearchService;
  tickets: TicketsService;
  bookings: BookingsService;
  knowledge?: KnowledgeSearchService;
  insights?: InsightsService;
}

/** The record as the member may see it (RecordsService: 404 for no access, foreign or missing alike), or null. */
export async function openRecord(deps: ReadToolDeps, ctx: ToolContext, kind: string, id: string): Promise<RecordSummary | null> {
  try {
    const r = await deps.records.get(ctx.workspaceId, ctx.viewer, kind, id);
    ctx.sources.record(r.kind, r.id, r.title);
    return r;
  } catch {
    return null;
  }
}

export const notFound = (kind: string) => ({ error: "not_found", note: `No ${kind} with that id is available to this member.` });

/** Keep only ids the member can open (canOpenRecord through RecordsService). */
export async function visibleIds(deps: ReadToolDeps, ctx: ToolContext, kind: string, ids: string[]): Promise<Set<string>> {
  const ok = await Promise.all(
    ids.map((id) =>
      deps.records
        .get(ctx.workspaceId, ctx.viewer, kind, id)
        .then(() => true)
        .catch(() => false),
    ),
  );
  return new Set(ids.filter((_, i) => ok[i]));
}
