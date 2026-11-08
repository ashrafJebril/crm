import { Injectable, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PermissionService } from "../permissions/permission.service";
import type { Viewer } from "../permissions/visibility";

interface ContactHit {
  id: string;
  name: string;
  phone: string | null;
  industry: string;
  lifecycle: string;
}

interface ConversationHit {
  id: string;
  channel: string;
  preview: string;
  contactId: string;
  contactName: string;
  lastAt: string;
}

interface TicketHit {
  id: string;
  number: number;
  title: string;
  pipelineId: string;
  stageLabel: string | null;
}

export interface SearchResults {
  contacts: ContactHit[];
  conversations: ConversationHit[];
  tickets: TicketHit[];
}

/**
 * Build a Postgres FTS query from a free-form user string.
 *
 * - Splits on whitespace.
 * - Strips punctuation so quotes/commas don't trip to_tsquery.
 * - Appends `:*` for prefix matching ("ali" hits "alice", "alibaba").
 * - Joins with `&` so all terms must match.
 *
 * Returns null when no usable terms remain (caller falls back to ILIKE).
 */
function buildTsQuery(raw: string): string | null {
  const terms = raw
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]+/gu, ""))
    .filter((t) => t.length >= 2)
    .map((t) => `${t}:*`);
  if (terms.length === 0) return null;
  return terms.join(" & ");
}

@Injectable()
export class SearchService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly perm?: PermissionService,
  ) {}

  /** What the requesting member may see in results. No viewer (internal
   *  caller) or a bypass session sees everything. */
  private async access(workspaceId: string, viewer?: Viewer) {
    if (!this.perm || !viewer || viewer.bypass) {
      return { contacts: true, conversations: true, tickets: true, assigneeId: null as string | null };
    }
    const [contacts, conversations, tickets, scope] = await Promise.all([
      this.perm.viewerCan(workspaceId, viewer, "contacts.view"),
      this.perm.viewerCan(workspaceId, viewer, "conversations.view"),
      this.perm.viewerCan(workspaceId, viewer, "tickets.view"),
      this.perm.conversationScope(workspaceId, viewer),
    ]);
    // "assigned" visibility = only conversations assigned to the viewer.
    const assigneeId = typeof scope.assigneeId === "string" ? scope.assigneeId : null;
    // A scope that is neither empty nor assigneeId (non-member) matches nothing.
    const closed = Object.keys(scope).length > 0 && assigneeId === null;
    return { contacts, conversations: conversations && !closed, tickets, assigneeId };
  }

  async search(
    workspaceId: string,
    rawQuery: string,
    limit: number,
    viewer?: Viewer,
  ): Promise<SearchResults> {
    const q = rawQuery.trim();
    const empty: SearchResults = { contacts: [], conversations: [], tickets: [] };
    if (q.length === 0) return empty;
    const acc = await this.access(workspaceId, viewer);

    const tsq = buildTsQuery(q);
    if (!tsq) {
      // Fallback for very short queries (< 2 alphanum chars): ILIKE on names.
      return acc.contacts ? this.ilikeFallback(workspaceId, q, limit) : empty;
    }

    // Run all three queries in parallel — each independently scoped + ranked.
    const [contacts, conversations, tickets] = await Promise.all([
      acc.contacts ? this.searchContacts(workspaceId, tsq, limit) : Promise.resolve([] as ContactHit[]),
      acc.conversations ? this.searchConversations(workspaceId, tsq, limit, acc.assigneeId) : Promise.resolve([] as ConversationHit[]),
      acc.tickets ? this.searchTickets(workspaceId, tsq, limit) : Promise.resolve([] as TicketHit[]),
    ]);

    return { contacts, conversations, tickets };
  }

  private async searchContacts(
    workspaceId: string,
    tsq: string,
    limit: number,
  ): Promise<ContactHit[]> {
    return this.prisma.$queryRaw<ContactHit[]>`
      SELECT
        c."id",
        c."name",
        c."phone",
        c."industry",
        c."lifecycle"
      FROM "Contact" c
      WHERE c."workspaceId" = ${workspaceId}
        AND c."searchVector" @@ to_tsquery('simple', ${tsq})
      ORDER BY ts_rank(c."searchVector", to_tsquery('simple', ${tsq})) DESC,
               c."updatedAt" DESC
      LIMIT ${Prisma.sql`${limit}`}
    `;
  }

  private async searchConversations(
    workspaceId: string,
    tsq: string,
    limit: number,
    assigneeId: string | null = null,
  ): Promise<ConversationHit[]> {
    const onlyAssigned = assigneeId
      ? Prisma.sql`AND conv."assigneeId" = ${assigneeId}`
      : Prisma.empty;
    return this.prisma.$queryRaw<ConversationHit[]>`
      SELECT
        conv."id",
        conv."channel",
        conv."preview",
        conv."contactId",
        contact."name" AS "contactName",
        conv."lastAt"
      FROM "Conversation" conv
      JOIN "Contact" contact ON contact."id" = conv."contactId"
      WHERE conv."workspaceId" = ${workspaceId}
        AND conv."searchVector" @@ to_tsquery('simple', ${tsq})
        ${onlyAssigned}
      ORDER BY ts_rank(conv."searchVector", to_tsquery('simple', ${tsq})) DESC,
               conv."updatedAt" DESC
      LIMIT ${Prisma.sql`${limit}`}
    `;
  }

  private async searchTickets(
    workspaceId: string,
    tsq: string,
    limit: number,
  ): Promise<TicketHit[]> {
    return this.prisma.$queryRaw<TicketHit[]>`
      SELECT
        t."id",
        t."number",
        t."title",
        t."pipelineId",
        stage."label" AS "stageLabel"
      FROM "Ticket" t
      LEFT JOIN "TicketStage" stage ON stage."id" = t."stageId"
      WHERE t."workspaceId" = ${workspaceId}
        AND t."searchVector" @@ to_tsquery('simple', ${tsq})
      ORDER BY ts_rank(t."searchVector", to_tsquery('simple', ${tsq})) DESC,
               t."updatedAt" DESC
      LIMIT ${Prisma.sql`${limit}`}
    `;
  }

  /**
   * Cheap fallback for 1-character queries where to_tsquery can't help —
   * just an ILIKE prefix on contact names so the user gets immediate hits
   * while they're still typing.
   */
  private async ilikeFallback(
    workspaceId: string,
    q: string,
    limit: number,
  ): Promise<SearchResults> {
    const pattern = `${q}%`;
    const contacts = await this.prisma.$queryRaw<ContactHit[]>`
      SELECT
        c."id",
        c."name",
        c."phone",
        c."industry",
        c."lifecycle"
      FROM "Contact" c
      WHERE c."workspaceId" = ${workspaceId}
        AND c."name" ILIKE ${pattern}
      ORDER BY c."updatedAt" DESC
      LIMIT ${Prisma.sql`${limit}`}
    `;
    return { contacts, conversations: [], tickets: [] };
  }
}
