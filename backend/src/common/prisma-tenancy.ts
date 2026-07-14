import { Prisma } from "@prisma/client";
import { getWorkspaceContext } from "./workspace-context";

/** Models that carry workspaceId and must always be scoped. */
const SCOPED_MODELS = new Set([
  "Contact",
  "Conversation",
  "Message",
  "Appointment",
  "Template",
  "Campaign",
  "Pipeline",
  "TicketStage",
  "Ticket",
  "TicketActivity",
  "Integration",
  "Note",
  "Media",
  "Segment",
]);

const READ_ACTIONS = new Set([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "count",
  "aggregate",
  "groupBy",
]);

const CREATE_ACTIONS = new Set(["create", "createMany"]);

// Every action whose `where` should be workspace-scoped. Prisma 5 allows extra
// (non-unique) filter fields in the where of single-record update/delete/upsert
// as long as a unique field is present, so injecting workspaceId here makes a
// cross-tenant single update/delete fail closed (P2025 RecordNotFound) instead
// of silently mutating another tenant's row.
const WHERE_ACTIONS = new Set([
  "updateMany",
  "deleteMany",
  "update",
  "delete",
]);

/**
 * Prisma client extension that auto-injects the active workspaceId on:
 *  - read filters (findMany, findFirst, count, aggregate, groupBy)
 *  - create payloads (single + createMany)
 *  - update/delete filters (bulk AND single-record)
 *  - upsert (where + create payload)
 * Acts as a safety net behind the explicit scoping in service methods.
 * Skipped entirely when no workspace context is set (migration scripts,
 * webhook ingestion, test setup, etc.).
 */
export const tenancyExtension = Prisma.defineExtension({
  name: "workspace-tenancy",
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const ctx = getWorkspaceContext();
        if (!ctx || !model || !SCOPED_MODELS.has(model)) {
          return query(args);
        }
        const wsId = ctx.workspaceId;

        if (READ_ACTIONS.has(operation)) {
          const a = (args ?? {}) as { where?: Record<string, unknown> };
          a.where = { ...(a.where ?? {}), workspaceId: wsId };
          return query(a as typeof args);
        }

        if (CREATE_ACTIONS.has(operation)) {
          const a = args as { data: Record<string, unknown> | Record<string, unknown>[] };
          if (Array.isArray(a.data)) {
            a.data = a.data.map((row) => ({ workspaceId: wsId, ...row }));
          } else {
            a.data = { workspaceId: wsId, ...a.data };
          }
          return query(a as typeof args);
        }

        if (WHERE_ACTIONS.has(operation)) {
          const a = (args ?? {}) as { where?: Record<string, unknown> };
          a.where = { ...(a.where ?? {}), workspaceId: wsId };
          return query(a as typeof args);
        }

        if (operation === "upsert") {
          const a = (args ?? {}) as {
            where?: Record<string, unknown>;
            create?: Record<string, unknown>;
          };
          a.where = { ...(a.where ?? {}), workspaceId: wsId };
          a.create = { workspaceId: wsId, ...(a.create ?? {}) };
          return query(a as typeof args);
        }

        if (operation === "findUnique" || operation === "findUniqueOrThrow") {
          const result = (await query(args)) as { workspaceId?: string } | null;
          if (result && result.workspaceId && result.workspaceId !== wsId) {
            return null as never;
          }
          return result as never;
        }

        return query(args);
      },
    },
  },
});
