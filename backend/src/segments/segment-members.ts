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
