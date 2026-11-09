import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { PrismaService } from "../prisma/prisma.service";
import type { MarketingOutboundService } from "./marketing-outbound.service";

/** Resolve a segment, asserting it's a manual group in this workspace. */
export async function requireManualGroup(prisma: PrismaService, workspaceId: string, id: string) {
  const seg = await prisma.segment.findFirst({ where: { id, workspaceId } });
  if (!seg) throw new NotFoundException("Segment not found");
  if (seg.origin !== "manual") {
    throw new BadRequestException("Members can only be managed on manual groups");
  }
  return seg;
}

/**
 * Idempotently add contacts to a manual group (shared by the segments
 * controller and the contacts bulk action). Rejects non-manual groups (400)
 * and contacts outside the workspace (404).
 */
export async function addManualMembers(
  prisma: PrismaService,
  outbound: Pick<MarketingOutboundService, "emitSegmentUpserted">,
  workspaceId: string,
  segmentId: string,
  contactIds: string[],
): Promise<{ added: number }> {
  await requireManualGroup(prisma, workspaceId, segmentId);
  const ids = [...new Set(contactIds)];
  const found = await prisma.contact.findMany({
    where: { workspaceId, id: { in: ids } },
    select: { id: true },
  });
  if (found.length !== ids.length) {
    throw new NotFoundException("One or more contacts not found in this workspace");
  }
  const res = await prisma.segmentMember.createMany({
    data: ids.map((contactId) => ({ segmentId, contactId })),
    skipDuplicates: true,
  });
  void outbound.emitSegmentUpserted(workspaceId, segmentId);
  return { added: res.count };
}

export const GROUP_NAME_MAX = 120;

/**
 * Create a manual group (origin "manual", empty filter) and emit it to HJZ.
 * Shared by the SP-12 campaign follow-up "create group" action. The name is
 * trimmed and must be 1-120 characters (400 otherwise).
 */
export async function createManualGroup(
  prisma: Pick<PrismaService, "segment">,
  outbound: Pick<MarketingOutboundService, "emitSegmentUpserted">,
  workspaceId: string,
  input: { name: string; nameAr?: string | null },
) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > GROUP_NAME_MAX) {
    throw new BadRequestException(`Group name must be 1-${GROUP_NAME_MAX} characters`);
  }
  const nameAr = typeof input.nameAr === "string" && input.nameAr.trim() ? input.nameAr.trim() : null;
  const seg = await prisma.segment.create({
    data: { workspaceId, name, nameAr, color: null, filter: "{}", origin: "manual" },
  });
  void outbound.emitSegmentUpserted(workspaceId, seg.id);
  return seg;
}
