import { Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

/**
 * SegmentFilter — server-side contract for the saved filter spec.
 *
 * Designed to stay narrow on purpose: every field maps cleanly to a Prisma
 * `where` predicate, so segment evaluation is one DB round-trip even when a
 * workspace has many segments to count. Extend cautiously; anything that needs
 * derived fields (RFM, conversation counts) belongs in a separate computed
 * path, not bolted on here.
 */
export interface SegmentFilter {
  lifecycle?: string[];
  industry?: string[];
  source?: string[];
  tagsAll?: string[]; // contact tags must contain ALL of these
  tagsAny?: string[]; // contact tags must contain ANY of these
  search?: string; // case-insensitive `name` substring
  hasPhone?: boolean;
}

@Injectable()
export class SegmentsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Resolve a SegmentFilter to a Prisma `where` clause, workspace-scoped. */
  buildWhere(workspaceId: string, f: SegmentFilter): Prisma.ContactWhereInput {
    const where: Prisma.ContactWhereInput = { workspaceId };
    if (f.lifecycle && f.lifecycle.length > 0) where.lifecycle = { in: f.lifecycle };
    if (f.industry && f.industry.length > 0) where.industry = { in: f.industry };
    if (f.source && f.source.length > 0) where.source = { in: f.source };
    if (f.search && f.search.trim().length > 0) {
      where.name = { contains: f.search.trim(), mode: "insensitive" };
    }
    if (f.hasPhone === true) where.phone = { not: null };
    if (f.hasPhone === false) where.phone = null;

    // tags is a TEXT column holding a JSON-encoded string array like ["VIP","Pro"].
    // We don't normalize it (yet) so we match via substring on the quoted form.
    // It's not perfect — "VIP" matches "VIPER" — but in practice tag names are
    // short and curated. If false positives ever bite we'll move to a join table.
    const tagClauses: Prisma.ContactWhereInput[] = [];
    if (f.tagsAll && f.tagsAll.length > 0) {
      for (const t of f.tagsAll) {
        tagClauses.push({ tags: { contains: JSON.stringify(t) } });
      }
    }
    if (f.tagsAny && f.tagsAny.length > 0) {
      tagClauses.push({
        OR: f.tagsAny.map((t) => ({ tags: { contains: JSON.stringify(t) } })),
      });
    }
    if (tagClauses.length > 0) {
      where.AND = [...(Array.isArray(where.AND) ? where.AND : []), ...tagClauses];
    }
    return where;
  }

  async countByFilter(workspaceId: string, filter: SegmentFilter): Promise<number> {
    return this.prisma.contact.count({
      where: this.buildWhere(workspaceId, filter),
    });
  }

  async getFilter(workspaceId: string, segmentId: string): Promise<SegmentFilter> {
    const row = await this.prisma.segment.findFirst({
      where: { id: segmentId, workspaceId },
    });
    if (!row) throw new NotFoundException("Segment not found");
    return this.parseFilter(row.filter);
  }

  parseFilter(raw: string): SegmentFilter {
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch {
      return {};
    }
  }
}
