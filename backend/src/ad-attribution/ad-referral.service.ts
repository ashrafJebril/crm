import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import type { AdSource } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { MediaService } from "../media/media.service";
import { parseMetaReferral, parseZernioReferral, type NormalizedReferral, type ReferralDropKey } from "./referral";
import { makeFetchCreative, rehostCreative, type FetchCreative, type RehostResult } from "./creative-rehost";

/** DI token for the creative fetcher (specs and Task 4 inject a stub). */
export const CREATIVE_FETCH = "SP15_CREATIVE_FETCH";

export type ReferralProvider = "zernio" | "meta";

export interface CaptureInput {
  workspaceId: string;
  channelId: string | null;
  conversationId: string;
  contactId: string;
  /** Our Message.id of the inbound message that carried the referral. */
  messageId: string;
  provider: ReferralProvider;
  referral: NormalizedReferral;
  /** The message time. */
  at: Date;
}

export interface CaptureResult {
  adSourceId: string;
  /** True when this touch set the conversation's first ad. */
  firstTouch: boolean;
}

export type CaptureContext = Omit<CaptureInput, "referral" | "provider">;

export interface SyncAdInput {
  sourceId: string;
  adAccountId: string | null;
  adName: string | null;
  adSetName: string | null;
  campaignName: string | null;
}

/** Creative fields filled from referrals, never overwritten with null. */
const CREATIVE = ["headline", "body", "mediaType", "sourceUrl", "welcomeText"] as const;
const SOURCE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

type Db = Pick<PrismaService, "adSource">;

const isUnique = (e: unknown) => (e as { code?: string })?.code === "P2002";

/** Find-or-create by `(workspaceId, sourceType, sourceId)`, race-safe (P2002 → re-read). */
async function findOrCreate(
  prisma: Db,
  key: { workspaceId: string; sourceType: string; sourceId: string },
  create: () => Record<string, unknown>,
): Promise<{ row: AdSource; created: boolean }> {
  const where = { workspaceId_sourceType_sourceId: key };
  const found = await prisma.adSource.findUnique({ where });
  if (found) return { row: found, created: false };
  try {
    const row = await prisma.adSource.create({ data: { ...key, ...create() } as never });
    return { row, created: true };
  } catch (e) {
    if (!isUnique(e)) throw e;
    const row = await prisma.adSource.findUnique({ where });
    if (!row) throw e;
    return { row, created: false };
  }
}

/**
 * Task 2's spend sync: the `AdSource` row for an insights `ad_id`. The sync
 * is the ad account's own read, so its names win (`namesFrom: "meta_sync"`)
 * and it sets `adAccountId`. Creative fields are never touched. A null name
 * never erases a known one. Returns null for an unusable ad id.
 */
export async function upsertAdSourceFromSync(
  prisma: Db,
  workspaceId: string,
  input: SyncAdInput,
): Promise<{ id: string } | null> {
  if (!SOURCE_ID.test(input.sourceId ?? "")) return null;
  const names = {
    ...(input.adName ? { adName: input.adName } : {}),
    ...(input.adSetName ? { adSetName: input.adSetName } : {}),
    ...(input.campaignName ? { campaignName: input.campaignName } : {}),
  };
  const hasNames = Object.keys(names).length > 0;
  const fields = {
    ...names,
    ...(hasNames ? { namesFrom: "meta_sync" } : {}),
    ...(input.adAccountId ? { adAccountId: input.adAccountId } : {}),
  };
  const { row, created } = await findOrCreate(
    prisma,
    { workspaceId, sourceType: "ad", sourceId: input.sourceId },
    () => fields,
  );
  if (!created && Object.entries(fields).some(([k, v]) => (row as Record<string, unknown>)[k] !== v)) {
    await prisma.adSource.update({ where: { id: row.id }, data: fields });
  }
  return { id: row.id };
}

/**
 * SP-15: stores click-to-WhatsApp referrals (Architecture → Capture).
 * `capture` runs after the inbound Message row exists and never throws: a
 * failure is logged as a key (no payload, no PII) and the webhook carries on.
 */
@Injectable()
export class AdReferralService {
  private readonly log = new Logger(AdReferralService.name);
  private readonly fetchCreative: FetchCreative;
  /** Re-hosts started by this instance and not yet finished (specs await them). */
  private readonly pending = new Set<Promise<RehostResult>>();

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly media?: MediaService,
    @Optional() @Inject(CREATIVE_FETCH) fetchCreative?: FetchCreative,
  ) {
    this.fetchCreative = fetchCreative ?? makeFetchCreative();
  }

  /** Zernio `message.received` / `conversation.started` (inbound only). Never throws. */
  async captureZernio(evt: unknown, ctx: CaptureContext): Promise<CaptureResult | null> {
    let referral: NormalizedReferral | null = null;
    try {
      referral = parseZernioReferral(evt, (k) => this.dropped(k, "zernio"));
    } catch {
      this.log.warn("referral_parse_failed provider=zernio");
    }
    return referral ? this.capture({ ...ctx, provider: "zernio", referral }) : null;
  }

  /** Meta-direct `messages[].referral`. Never throws. */
  async captureMeta(raw: unknown, ctx: CaptureContext): Promise<CaptureResult | null> {
    if (raw === undefined || raw === null) return null;
    let referral: NormalizedReferral | null = null;
    try {
      referral = parseMetaReferral(raw, (k) => this.dropped(k, "meta"));
    } catch {
      this.log.warn("referral_parse_failed provider=meta");
    }
    return referral ? this.capture({ ...ctx, provider: "meta", referral }) : null;
  }

  private dropped(key: ReferralDropKey, provider: ReferralProvider) {
    this.log.warn(`${key} provider=${provider}`);
  }

  /**
   * 1. upsert the workspace's AdSource (fill-only for creative fields);
   * 2. insert one AdReferral per message (`messageId` unique: a redelivery is
   *    a no-op and returns null);
   * 3. set the conversation's first touch only while `adSourceId` is null
   *    (one conditional update, so only one referral wins, also under a race);
   * 4. queue the creative re-host without awaiting it.
   */
  async capture(input: CaptureInput): Promise<CaptureResult | null> {
    try {
      return await this.doCapture(input);
    } catch (e) {
      const code = (e as { code?: string })?.code ?? (e as Error)?.name ?? "error";
      this.log.warn(`referral_capture_failed provider=${input.provider} code=${String(code).slice(0, 40)}`);
      return null;
    }
  }

  private async doCapture(input: CaptureInput): Promise<CaptureResult | null> {
    const { workspaceId, referral: ref, at } = input;
    const seen = await this.prisma.adReferral.findUnique({ where: { messageId: input.messageId }, select: { id: true } });
    if (seen) return null;

    const src = await this.upsertFromReferral(workspaceId, ref, at);

    const inserted = await this.prisma.adReferral.createMany({
      data: [
        {
          workspaceId,
          adSourceId: src.id,
          conversationId: input.conversationId,
          contactId: input.contactId,
          channelId: input.channelId,
          messageId: input.messageId,
          provider: input.provider,
          ctwaClid: ref.ctwaClid,
          firstTouch: false,
          referredAt: at,
        },
      ],
      skipDuplicates: true,
    });
    if (inserted.count === 0) return null;

    const firstTouch = await this.prisma.$transaction(async (tx) => {
      const won = await tx.conversation.updateMany({
        where: { id: input.conversationId, workspaceId, adSourceId: null },
        data: { adSourceId: src.id, adReferredAt: at },
      });
      if (won.count !== 1) return false;
      await tx.adReferral.updateMany({ where: { messageId: input.messageId, workspaceId }, data: { firstTouch: true } });
      return true;
    });

    if (!src.mediaId && src.mediaUrl) this.queueRehost(src);
    return { adSourceId: src.id, firstTouch };
  }

  private async upsertFromReferral(workspaceId: string, ref: NormalizedReferral, at: Date): Promise<AdSource> {
    const names = ref.names;
    const { row, created } = await findOrCreate(
      this.prisma,
      { workspaceId, sourceType: ref.sourceType, sourceId: ref.sourceId },
      () => ({
        headline: ref.headline,
        body: ref.body,
        mediaType: ref.mediaType,
        mediaUrl: ref.mediaUrl,
        sourceUrl: ref.sourceUrl,
        welcomeText: ref.welcomeText,
        adName: names?.adName ?? null,
        adSetName: names?.adSetName ?? null,
        campaignName: names?.campaignName ?? null,
        adAccountId: names?.adAccountId ?? null,
        namesFrom: names && (names.adName || names.adSetName || names.campaignName) ? "zernio" : null,
        firstReferredAt: at,
        lastReferredAt: at,
      }),
    );
    if (created) return row;

    const patch: Record<string, unknown> = {};
    for (const f of CREATIVE) if (row[f] == null && ref[f] != null) patch[f] = ref[f];
    // A fresh signed link replaces an older one while nothing is re-hosted,
    // so the retry on this referral fetches a link that still loads.
    if (!row.mediaId && ref.mediaUrl && ref.mediaUrl !== row.mediaUrl) patch.mediaUrl = ref.mediaUrl;
    // Zernio's synced names; the Meta spend sync's names always win (ruling 3).
    if (names && row.namesFrom !== "meta_sync") {
      let named = false;
      for (const f of ["adName", "adSetName", "campaignName"] as const) {
        if (names[f] && names[f] !== row[f]) patch[f] = names[f];
        if (names[f]) named = true;
      }
      if (named && row.namesFrom !== "zernio") patch.namesFrom = "zernio";
    }
    if (names?.adAccountId && !row.adAccountId) patch.adAccountId = names.adAccountId;
    if (!row.firstReferredAt || at < row.firstReferredAt) patch.firstReferredAt = at;
    if (!row.lastReferredAt || at > row.lastReferredAt) patch.lastReferredAt = at;
    if (Object.keys(patch).length === 0) return row;
    return this.prisma.adSource.update({ where: { id: row.id }, data: patch });
  }

  /** Task 2: see `upsertAdSourceFromSync`. */
  upsertFromSync(workspaceId: string, input: SyncAdInput): Promise<{ id: string } | null> {
    return upsertAdSourceFromSync(this.prisma, workspaceId, input);
  }

  private queueRehost(src: AdSource) {
    if (!this.media) return;
    const p = rehostCreative(src, { prisma: this.prisma, media: this.media, fetchCreative: this.fetchCreative, log: this.log });
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  /** Specs: wait for every queued re-host to settle. */
  async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }
}
