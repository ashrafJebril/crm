import { NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type { PrismaService } from "../../prisma/prisma.service";
import { campaignError } from "../campaign-errors";

/**
 * The one audience resolver every campaign path uses (SP-16 F1): the
 * segments service's `resolveContactWhere`, which compiles a smart audience
 * through the same compiler as the contacts list and resolves manual and hjz
 * groups by membership, unchanged.
 */
export interface AudienceResolver {
  resolveContactWhere(workspaceId: string, segmentId: string, opts?: { now?: Date }): Promise<Prisma.ContactWhereInput>;
}

/**
 * A campaign's audience as one `where`, resolved ONCE per preview or launch
 * with one `now` (ruling 17: a launch passes its plan start, so a relative
 * window cannot move between page 1 and page 100).
 * - No segment: the whole workspace.
 * - A segment that is gone (deleted, or foreign): 400
 *   `campaigns.audience_missing {segmentId}`, never the whole workspace.
 */
export async function resolveCampaignAudience(
  resolver: AudienceResolver,
  workspaceId: string,
  segmentId: string | null | undefined,
  now: Date,
): Promise<Prisma.ContactWhereInput> {
  if (!segmentId) return { workspaceId };
  try {
    return await resolver.resolveContactWhere(workspaceId, segmentId, { now });
  } catch (e) {
    if (e instanceof NotFoundException) throw campaignError("campaigns.audience_missing", { segmentId });
    throw e;
  }
}

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
 * The campaign audience (`audienceWhere`, from `resolveCampaignAudience`) as
 * keyset pages of `pageSize` contacts by ascending id (`id > cursor`). The
 * audience sits whole inside `AND`, so none of its own keys (for example the
 * compiler's match-nobody `{id: {in: []}}`) can be overwritten by the
 * cursor's `id`. Each page has the stored values of `defIds` loaded in one
 * query. Never holds the whole audience in memory. Used by the preview and
 * the launch plan stage. `defIds` must already be this workspace's defs (the
 * values table has no workspace column; contacts are workspace-scoped, so
 * values follow).
 */
export async function* streamAudience(
  prisma: PrismaService,
  workspaceId: string,
  audienceWhere: Prisma.ContactWhereInput,
  defIds: readonly string[],
  pageSize = AUDIENCE_PAGE,
): AsyncGenerator<AudiencePage> {
  let cursor: string | null = null;
  for (;;) {
    const contacts = (await prisma.contact.findMany({
      where: {
        workspaceId,
        AND: [audienceWhere],
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
