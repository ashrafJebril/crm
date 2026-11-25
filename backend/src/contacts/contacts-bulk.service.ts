import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { MarketingOutboundService } from "../segments/marketing-outbound.service";
import { addManualMembers } from "../segments/segment-members";
import { TagsService } from "../tags/tags.module";
import { TicketsService } from "../tickets/tickets.service";
import { ContactsService } from "./contacts.service";
import { parseContactFilter } from "./contact-filter";
import { BULK_IDS_CAP, BULK_OPS, type BulkContactsDto } from "./contacts.dto";

export { BULK_IDS_CAP };
/** Each new ticket can start automations — keep one click from firing thousands. */
export const PIPELINE_BULK_CAP = 500;

export interface BulkResult {
  affected: number;
  skipped?: number;
  blocked?: string[];
  created?: number;
  truncated?: boolean;
}

@Injectable()
export class ContactsBulkService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly contacts: ContactsService,
    private readonly tags: TagsService,
    private readonly tickets: TicketsService,
    private readonly outbound: MarketingOutboundService,
  ) {}

  async run(workspaceId: string, dto: BulkContactsDto): Promise<BulkResult> {
    if ((dto.ids === undefined) === (dto.filter === undefined)) {
      throw new BadRequestException("Provide exactly one of ids or filter");
    }
    if (!BULK_OPS.includes(dto.op)) throw new BadRequestException("Unknown bulk op");
    // Deleting by a filter is too easy to get wrong; the UI always sends ids.
    if (dto.op === "delete" && dto.ids === undefined) throw new BadRequestException("Delete needs explicit ids");
    if (dto.ids !== undefined && dto.ids.length > BULK_IDS_CAP) {
      throw new BadRequestException(`At most ${BULK_IDS_CAP} contacts per bulk action`);
    }

    let ids: string[];
    let truncated: boolean | undefined;
    if (dto.ids !== undefined) {
      ids = [...new Set(dto.ids)];
      if (ids.length) {
        const found = await this.prisma.contact.findMany({
          where: { workspaceId, id: { in: ids } },
          select: { id: true },
        });
        if (found.length !== ids.length) {
          throw new NotFoundException("One or more contacts not found in this workspace");
        }
      }
    } else {
      const res = await this.contacts.listIds(workspaceId, parseContactFilter(dto.filter));
      ids = res.ids;
      truncated = res.truncated;
    }

    const result = await this.apply(workspaceId, ids, dto);
    return truncated ? { ...result, truncated: true } : result;
  }

  private async apply(workspaceId: string, ids: string[], dto: BulkContactsDto): Promise<BulkResult> {
    const scope = { workspaceId, id: { in: ids } };
    const update = async (data: { ownerId?: string | null; marketingOptOut?: boolean; notALead?: boolean }) => {
      if (!ids.length) return { affected: 0 };
      const r = await this.prisma.contact.updateMany({ where: scope, data });
      return { affected: r.count };
    };
    const requireBool = () => {
      if (typeof dto.value !== "boolean") throw new BadRequestException("value must be a boolean");
      return dto.value;
    };

    switch (dto.op) {
      case "addTags":
      case "removeTags": {
        if (!dto.names?.length) throw new BadRequestException("names required");
        if (!ids.length) return { affected: 0 };
        const r = await this.tags.assign(
          workspaceId,
          dto.op === "addTags" ? { contactIds: ids, add: dto.names } : { contactIds: ids, remove: dto.names },
        );
        return { affected: r.contactsUpdated };
      }
      case "addToGroup": {
        if (!dto.segmentId) throw new BadRequestException("segmentId required");
        const r = await addManualMembers(this.prisma, this.outbound, workspaceId, dto.segmentId, ids);
        return { affected: r.added };
      }
      case "setOwner": {
        if (dto.ownerId === undefined) throw new BadRequestException("ownerId required (or null to unassign)");
        if (dto.ownerId !== null) {
          const member = await this.prisma.workspaceMember.findFirst({
            where: { workspaceId, userId: dto.ownerId },
          });
          if (!member) throw new BadRequestException("owner is not a member");
        }
        return update({ ownerId: dto.ownerId });
      }
      case "setOptOut":
        return update({ marketingOptOut: requireBool() });
      case "setNotALead":
        return update({ notALead: requireBool() });
      case "addToPipeline":
        return this.addToPipeline(workspaceId, ids, dto);
      case "delete":
        return this.remove(workspaceId, ids, dto.force === true);
    }
  }

  private async addToPipeline(workspaceId: string, ids: string[], dto: BulkContactsDto): Promise<BulkResult> {
    if (!dto.pipelineId) throw new BadRequestException("pipelineId required");
    const pipeline = await this.prisma.pipeline.findFirst({ where: { id: dto.pipelineId, workspaceId } });
    if (!pipeline) throw new NotFoundException("Pipeline not found");
    // Archived pipelines take no new tickets: refuse before any work (SP-07).
    if (pipeline.archivedAt) throw new BadRequestException("pipelines.archived");
    if (!ids.length) return { affected: 0, created: 0, skipped: 0 };
    if (ids.length > PIPELINE_BULK_CAP) {
      // Bilingual like the tags API's conflict message; the UI disables the
      // action above the cap, so this is only the server-side backstop.
      throw new BadRequestException(
        "Add up to 500 contacts to a pipeline at a time. — أضف حتى ٥٠٠ جهة اتصال إلى المسار في كل مرة.",
      );
    }
    let stageId = dto.stageId;
    if (!stageId) {
      const first = await this.prisma.ticketStage.findFirst({
        where: { pipelineId: dto.pipelineId, workspaceId },
        orderBy: { order: "asc" },
      });
      if (!first) throw new BadRequestException("Pipeline has no stages");
      stageId = first.id;
    }
    const open = await this.prisma.ticket.findMany({
      where: { workspaceId, pipelineId: dto.pipelineId, closedAt: null, contactId: { in: ids } },
      select: { contactId: true },
    });
    const hasOpen = new Set(open.map((t) => t.contactId));
    const todo = ids.filter((id) => !hasOpen.has(id));
    const rows = todo.length
      ? await this.prisma.contact.findMany({
          where: { workspaceId, id: { in: todo } },
          select: { id: true, name: true },
        })
      : [];
    const names = new Map(rows.map((r) => [r.id, r.name]));
    let created = 0;
    // Sequential: ticket numbers are allocated per pipeline.
    for (const contactId of todo) {
      try {
        await this.tickets.createTicket(workspaceId, {
          pipelineId: dto.pipelineId,
          stageId,
          contactId,
          title: names.get(contactId) ?? "Ticket",
        });
        created += 1;
      } catch (e) {
        // Leads pipelines keep one open card per contact (SP-08). The pre-check above
        // covers the normal case; this covers a card opened concurrently since then.
        if (e instanceof ConflictException) continue;
        throw e;
      }
    }
    return { affected: created, created, skipped: ids.length - created };
  }

  private async remove(workspaceId: string, ids: string[], force: boolean): Promise<BulkResult> {
    if (!ids.length) return { affected: 0 };
    let blocked: string[] = [];
    if (!force) {
      const linked = await this.prisma.contact.findMany({
        where: {
          workspaceId,
          id: { in: ids },
          OR: [{ tickets: { some: {} } }, { appointments: { some: {} } }],
        },
        select: { id: true },
      });
      blocked = linked.map((l) => l.id);
    }
    const blockedSet = new Set(blocked);
    const deletable = ids.filter((id) => !blockedSet.has(id));
    const r = deletable.length
      ? await this.prisma.contact.deleteMany({ where: { workspaceId, id: { in: deletable } } })
      : { count: 0 };
    return blocked.length
      ? { affected: r.count, skipped: blocked.length, blocked }
      : { affected: r.count };
  }
}
