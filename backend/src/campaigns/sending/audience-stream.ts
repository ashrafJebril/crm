import type { PrismaService } from "../../prisma/prisma.service";

/** The contact columns campaigns read (audience rules + varMap fields). */
export interface StreamedContact {
  id: string;
  name: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  email: string | null;
  lifecycle: string;
  marketingOptOut: boolean;
}

export interface AudiencePage {
  /** In ascending id order. */
  contacts: StreamedContact[];
  /** contactId → {defId → stored JSON value}, for the requested defs only. */
  customValues: Map<string, Record<string, unknown>>;
}

/** Audience page size (contacts per keyset page). */
export const AUDIENCE_PAGE = 1000;

/**
 * The campaign audience (a segment's members, or the whole workspace) as
 * keyset pages of `pageSize` contacts by ascending id (`id > cursor`), each
 * with the stored values of `defIds` loaded in one query. Never holds the
 * whole audience in memory. Used by the preview and the launch plan stage.
 * `defIds` must already be this workspace's defs (the values table has no
 * workspace column; contacts are workspace-scoped, so values follow).
 */
export async function* streamAudience(
  prisma: PrismaService,
  workspaceId: string,
  segmentId: string | null | undefined,
  defIds: readonly string[],
  pageSize = AUDIENCE_PAGE,
): AsyncGenerator<AudiencePage> {
  let cursor: string | null = null;
  for (;;) {
    const contacts = (await prisma.contact.findMany({
      where: {
        workspaceId,
        ...(segmentId ? { segmentMembers: { some: { segmentId } } } : {}),
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      orderBy: { id: "asc" },
      take: pageSize,
      select: {
        id: true,
        name: true,
        firstName: true,
        lastName: true,
        phone: true,
        email: true,
        lifecycle: true,
        marketingOptOut: true,
      },
    })) as StreamedContact[];
    if (contacts.length === 0) return;
    const customValues = new Map<string, Record<string, unknown>>();
    if (defIds.length > 0) {
      const rows = (await prisma.customFieldValue.findMany({
        where: { defId: { in: [...defIds] }, contactId: { in: contacts.map((c) => c.id) } },
        select: { defId: true, contactId: true, value: true },
      })) as Array<{ defId: string; contactId: string; value: unknown }>;
      for (const r of rows) {
        const m = customValues.get(r.contactId) ?? {};
        m[r.defId] = r.value;
        customValues.set(r.contactId, m);
      }
    }
    yield { contacts, customValues };
    if (contacts.length < pageSize) return;
    cursor = contacts[contacts.length - 1].id;
  }
}
