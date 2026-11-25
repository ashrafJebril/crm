import { HttpException, Injectable, InternalServerErrorException, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { MarketingOutboundService } from "../segments/marketing-outbound.service";
import { addManualMembers, createManualGroup, requireManualGroup } from "../segments/segment-members";
import { TagsService } from "../tags/tags.module";
import { BULK_IDS_CAP } from "../contacts/contacts.dto";
import { campaignError } from "./campaign-errors";
import { FOLLOW_UP_IDS_CAP } from "./campaign-report.dto";
import { RECIPIENT_STATUSES, type RecipientStatus } from "./tracking/recipient-status";

export { FOLLOW_UP_IDS_CAP };
/** Writes per call to the group and tag services. */
export const FOLLOW_UP_CHUNK = 1000;
/** Distinct contacts one synchronous action may touch (ruling 9); equals BULK_IDS_CAP. */
export const FOLLOW_UP_CONTACTS_CAP: number = BULK_IDS_CAP;
/** Keyset batch for reading an outcome's rows. */
export const ROW_SCAN_BATCH = 5000;

export interface FollowUpTarget {
  status?: RecipientStatus;
  ids?: string[];
}

export interface FollowUpResult {
  added: number;
  already?: number;
  leftOut: number;
  groupId?: string;
}

/** Emission is done once per action by the caller, not once per chunk. */
const NO_EMIT = { emitSegmentUpserted: async () => false };

const chunks = <T>(xs: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

/**
 * SP-12 follow-up actions from a campaign outcome or ticked recipient rows.
 * Contacts come only from rows checked against the workspace AND the
 * campaign, and are re-read inside the workspace before any write.
 */
@Injectable()
export class CampaignFollowUpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbound: MarketingOutboundService,
    private readonly tags: TagsService,
  ) {}

  async createGroup(
    workspaceId: string,
    campaignId: string,
    dto: FollowUpTarget & { name: string; nameAr?: string },
  ): Promise<FollowUpResult> {
    await this.loadCampaign(workspaceId, campaignId);
    const target = this.checkTarget(dto);
    const name = typeof dto.name === "string" ? dto.name.trim() : "";
    if (!name) throw campaignError("campaigns.group_name_required");
    const { contactIds, leftOut } = await this.resolve(workspaceId, campaignId, target);
    const seg = await createManualGroup(this.prisma, NO_EMIT, workspaceId, { name, nameAr: dto.nameAr });
    const progress = { added: 0 };
    let ok = false;
    try {
      await this.addMembers(workspaceId, seg.id, contactIds, progress);
      ok = true;
    } catch (e) {
      // Partial failure: the group exists and holds `added` members. Return its
      // id so the user can finish with add-to-group instead of creating a duplicate.
      const extra = { groupId: seg.id, added: progress.added };
      if (e instanceof HttpException) {
        const r = e.getResponse();
        const body = typeof r === "object" && r !== null ? r : { statusCode: e.getStatus(), message: r };
        throw new HttpException({ ...body, ...extra }, e.getStatus());
      }
      throw new InternalServerErrorException({ statusCode: 500, message: "Internal server error", ...extra });
    } finally {
      if (ok || progress.added > 0) void this.outbound.emitSegmentUpserted(workspaceId, seg.id);
    }
    return { added: progress.added, already: contactIds.length - progress.added, leftOut, groupId: seg.id };
  }

  async addToGroup(
    workspaceId: string,
    campaignId: string,
    dto: FollowUpTarget & { groupId: string },
  ): Promise<FollowUpResult> {
    await this.loadCampaign(workspaceId, campaignId);
    const target = this.checkTarget(dto);
    // Foreign or missing → 404; non-manual → 400 (passed through from segments).
    const seg = await requireManualGroup(this.prisma, workspaceId, dto.groupId);
    const { contactIds, leftOut } = await this.resolve(workspaceId, campaignId, target);
    const added = await this.addMembers(workspaceId, seg.id, contactIds);
    if (contactIds.length) void this.outbound.emitSegmentUpserted(workspaceId, seg.id);
    return { added, already: contactIds.length - added, leftOut, groupId: seg.id };
  }

  async tag(workspaceId: string, campaignId: string, dto: FollowUpTarget & { tagId: string }): Promise<FollowUpResult> {
    await this.loadCampaign(workspaceId, campaignId);
    const target = this.checkTarget(dto);
    const tag = await this.prisma.tag.findFirst({ where: { id: dto.tagId, workspaceId } });
    if (!tag) throw new NotFoundException("Tag not found");
    const { contactIds, leftOut } = await this.resolve(workspaceId, campaignId, target);
    let added = 0;
    for (const chunk of chunks(contactIds, FOLLOW_UP_CHUNK)) {
      const r = await this.tags.assign(workspaceId, { contactIds: chunk, add: [tag.name] });
      added += r.contactsUpdated;
    }
    return { added, already: contactIds.length - added, leftOut };
  }

  private async loadCampaign(workspaceId: string, id: string) {
    const c = await this.prisma.campaign.findFirst({ where: { id, workspaceId }, select: { id: true } });
    if (!c) throw campaignError("campaigns.not_found");
    return c;
  }

  /** Exactly one of `status` or a non-empty `ids`. */
  private checkTarget(dto: FollowUpTarget): { status: RecipientStatus } | { ids: string[] } {
    const hasStatus = dto.status !== undefined && dto.status !== null;
    const hasIds = Array.isArray(dto.ids) && dto.ids.length > 0;
    if (hasStatus === hasIds) throw campaignError("campaigns.follow_up_target");
    if (hasIds) {
      if (dto.ids!.length > FOLLOW_UP_IDS_CAP) throw campaignError("campaigns.ids_too_many", { limit: FOLLOW_UP_IDS_CAP });
      return { ids: [...new Set(dto.ids!)] };
    }
    if (!(RECIPIENT_STATUSES as readonly string[]).includes(dto.status as string)) {
      throw campaignError("campaigns.invalid_status");
    }
    return { status: dto.status! };
  }

  /**
   * The distinct contacts behind the target rows, re-read inside the
   * workspace. Rows whose contact was deleted (null, or no longer there)
   * count as `leftOut`. Nothing is written here, so a 404 or a cap error
   * leaves everything unchanged.
   */
  private async resolve(
    workspaceId: string,
    campaignId: string,
    target: { status: RecipientStatus } | { ids: string[] },
  ): Promise<{ contactIds: string[]; leftOut: number }> {
    const perContact = new Map<string, number>();
    let leftOut = 0;
    const take = (rows: { contactId: string | null }[]) => {
      for (const r of rows) {
        if (!r.contactId) leftOut++;
        else perContact.set(r.contactId, (perContact.get(r.contactId) ?? 0) + 1);
      }
      // Checked per batch, so an oversized outcome is rejected without reading
      // every row. `count` is then the distinct contacts seen so far (> limit).
      if (perContact.size > FOLLOW_UP_CONTACTS_CAP) {
        throw campaignError("campaigns.follow_up_too_large", { limit: FOLLOW_UP_CONTACTS_CAP, count: perContact.size });
      }
    };
    if ("ids" in target) {
      const found = await this.prisma.campaignRecipient.findMany({
        where: { workspaceId, campaignId, id: { in: target.ids } },
        select: { id: true, contactId: true },
      });
      if (found.length !== target.ids.length) throw campaignError("campaigns.recipient_not_found");
      take(found);
    } else {
      // Keyset over (campaignId, status, id): bounded queries even for a 100k outcome.
      let last: string | null = null;
      for (;;) {
        const batch: { id: string; contactId: string | null }[] = await this.prisma.campaignRecipient.findMany({
          where: {
            workspaceId,
            campaignId,
            status: target.status,
            ...(last !== null ? { id: { gt: last } } : {}),
          },
          orderBy: { id: "asc" },
          take: ROW_SCAN_BATCH,
          select: { id: true, contactId: true },
        });
        take(batch);
        if (batch.length < ROW_SCAN_BATCH) break;
        last = batch[batch.length - 1].id;
      }
    }

    const existing = new Set<string>();
    for (const chunk of chunks([...perContact.keys()], FOLLOW_UP_CHUNK)) {
      const found = await this.prisma.contact.findMany({
        where: { workspaceId, id: { in: chunk } },
        select: { id: true },
      });
      for (const c of found) existing.add(c.id);
    }
    const contactIds: string[] = [];
    for (const [id, n] of perContact) {
      if (existing.has(id)) contactIds.push(id);
      else leftOut += n;
    }
    return { contactIds, leftOut };
  }

  /** `progress.added` is kept current per chunk, so a caller can report a partial write. */
  private async addMembers(
    workspaceId: string,
    segmentId: string,
    contactIds: string[],
    progress: { added: number } = { added: 0 },
  ): Promise<number> {
    for (const chunk of chunks(contactIds, FOLLOW_UP_CHUNK)) {
      const r = await addManualMembers(this.prisma, NO_EMIT, workspaceId, segmentId, chunk);
      progress.added += r.added;
    }
    return progress.added;
  }
}
