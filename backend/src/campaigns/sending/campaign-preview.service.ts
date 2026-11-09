import { Injectable } from "@nestjs/common";
import { MediaService } from "../../media/media.service";
import type { Viewer } from "../../permissions/visibility";
import { PrismaService } from "../../prisma/prisma.service";
import { ZernioClient } from "../../integrations/zernio.client";
import { campaignSender, campaignSenderOptions, campaignSenders } from "../../channels/default-channel";
import { buildRecipients, estimateMetaCost, templatePlaceholderCount } from "../campaign-audience";
import { campaignError } from "../campaign-errors";
import { streamAudience, type StreamedContact } from "./audience-stream";
import { campaignDirectMax, campaignMaxPartitions, partitionKey, planTransport, slotsInOrder, type TransportKind } from "./partition";
import { assignSender, normalizeSenderWrite, splitCounts, templateOnSenders } from "./senders";
import {
  type CustomDef,
  fieldLabel,
  resolveSlot,
  resolveVarMap,
  slotKeys,
  type VarMap,
  type VarSource,
  validateVarMap,
  validateVarMapShape,
} from "./var-map";

/** `POST /campaigns/preview` body (every field optional). */
export interface CampaignPreviewBody {
  segmentId?: string | null;
  templateId?: string | null;
  senderChannelIds?: string[] | null;
  senderChannelId?: string | null;
  varMap?: unknown;
  headerMediaId?: string | null;
}

export interface PreviewSender {
  channelId: string | null;
  accountId: string;
  displayName: string;
  phoneNumber: string | null;
}

export interface PreviewSample {
  contactId: string;
  name: string;
  rendered: string;
  values: string[];
  usedFallback: number[];
  skippedFor: { source: VarSource; key: string } | null;
}

export interface CampaignPreview {
  connected: boolean;
  total: number;
  reachable: number;
  skipped: { noPhone: number; optedOut: number; duplicate: number; missingValue: number };
  missingByKey: Array<{ source: VarSource; key: string; label: string; labelAr: string; count: number }>;
  split: Array<{ channelId: string | null; displayName: string; phoneNumber: string | null; recipients: number }>;
  transport: { kind: TransportKind; partitions: number; limit: number; directLimit: number };
  templateMissing: string[];
  /** Senders whose templates Zernio could not return (launch fails closed on them). */
  templateCheckFailed: string[];
  samples: PreviewSample[];
  estimate: { usd: number; unpriced: number };
}

/** `{{n}}` → `values[n-1]`; an empty or absent value keeps the token. */
export function renderTemplate(body: string, values: readonly string[]): string {
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (tok, n: string) => {
    const v = values[Number(n) - 1];
    return v ? v : tok;
  });
}

/**
 * SP-13 review step: who the campaign reaches, how it splits across its
 * numbers, which values are missing, the transport it will need, whether
 * every number holds the template, and up to three real-contact samples.
 *
 * It runs the launch plan's pipeline (`streamAudience` keyset pages →
 * `buildRecipients` → `resolveVarMap` → `assignSender`) and writes nothing.
 * Not connected is not an error here: `connected: false` (ruling 6).
 */
@Injectable()
export class CampaignPreviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly zernio: ZernioClient,
    private readonly media: MediaService,
  ) {}

  async preview(
    workspaceId: string,
    body: CampaignPreviewBody,
    opts: { canViewContacts: boolean; viewer?: Viewer },
  ): Promise<CampaignPreview> {
    const senderWrite = normalizeSenderWrite({
      senderChannelIds: body.senderChannelIds ?? undefined,
      senderChannelId: body.senderChannelId,
    });

    const template = body.templateId
      ? await this.prisma.template.findFirst({
          where: { id: body.templateId, workspaceId },
          select: { id: true, name: true, lang: true, body: true, status: true },
        })
      : null;
    // A body id never 404s (ruling 11): unknown or foreign → 400.
    if (body.templateId && !template) throw campaignError("campaigns.template_not_approved");

    // Through MediaService.get with the viewer: foreign, unknown or (for an
    // assigned-only member) invisible media → 404 (fix round 1, M2).
    if (body.headerMediaId) await this.media.get(workspaceId, body.headerMediaId, opts.viewer);

    const map = await this.loadVarMap(workspaceId, body.varMap, template);
    const defs = map.defs;

    const options = await campaignSenderOptions(this.prisma, workspaceId);
    const connected = options.connected;
    const senders = connected ? await this.resolveSenders(workspaceId, senderWrite?.senderChannelIds ?? []) : [];

    // The pipeline.
    const seen = new Set<string>();
    const skipped = { noPhone: 0, optedOut: 0, duplicate: 0, missingValue: 0 };
    const missing = new Map<string, { source: VarSource; key: string; count: number }>();
    const partitions = new Set<string>();
    const slots = map.varMap ? slotsInOrder(map.varMap) : [];
    const estimate = { usd: 0, unpriced: 0 };
    let total = 0;
    let reachable = 0;
    const sampleSlots: { reachable?: PreviewSample; fallback?: PreviewSample; skipped?: PreviewSample } = {};
    const wantSamples = opts.canViewContacts && !!template;

    for await (const page of streamAudience(this.prisma, workspaceId, body.segmentId || null, map.defIds)) {
      total += page.contacts.length;
      const built = buildRecipients(page.contacts, seen);
      skipped.noPhone += built.skipped.noPhone;
      skipped.optedOut += built.skipped.optedOut;
      skipped.duplicate += built.skipped.duplicate;
      const byId = new Map(page.contacts.map((c) => [c.id, c]));
      const phones: string[] = [];
      for (const r of built.recipients) {
        const contact = byId.get(r.contactId as string) as StreamedContact;
        const custom = page.customValues.get(contact.id) ?? {};
        let values: string[] = [];
        let usedFallback: number[] = [];
        if (map.varMap) {
          const res = resolveVarMap(map.varMap, { ...contact, phone: r.phone }, custom, { lang: template?.lang ?? "en", defs });
          if (!res.ok) {
            skipped.missingValue++;
            const k = `${res.missing.source}.${res.missing.key}`;
            const m = missing.get(k) ?? { source: res.missing.source, key: res.missing.key, count: 0 };
            m.count++;
            missing.set(k, m);
            if (wantSamples && !sampleSlots.skipped) {
              sampleSlots.skipped = this.skippedSample(map.varMap, contact, r.phone, custom, template!, defs, res.missing);
            }
            continue;
          }
          values = res.values;
          usedFallback = res.usedFallback;
        }
        const sender = senders.length ? assignSender(reachable, senders) : null;
        reachable++;
        phones.push(r.phone);
        if (sender) partitions.add(partitionKey(sender.channelId, values, slots));
        if (wantSamples) {
          const sample = (): PreviewSample => ({
            contactId: contact.id,
            name: contact.name,
            rendered: renderTemplate(template!.body ?? "", values),
            values,
            usedFallback,
            skippedFor: null,
          });
          if (!sampleSlots.reachable) sampleSlots.reachable = sample();
          else if (!sampleSlots.fallback && usedFallback.length > 0) sampleSlots.fallback = sample();
        }
      }
      const cost = estimateMetaCost(phones);
      estimate.usd += cost.usd;
      estimate.unpriced += cost.unpriced;
    }

    const counts = splitCounts(reachable, senders);
    const split = senders
      .map((s, i) => ({ channelId: s.channelId, displayName: s.displayName, phoneNumber: s.phoneNumber, recipients: counts[i], i }))
      .sort((a, b) => b.recipients - a.recipients || a.i - b.i)
      .map(({ i: _i, ...rest }) => rest);

    let templateMissing: string[] = [];
    let templateCheckFailed: string[] = [];
    if (template && connected && senders.length > 0) {
      const r = await templateOnSenders(this.zernio, senders, { name: template.name, lang: template.lang });
      templateMissing = r.missing;
      templateCheckFailed = r.failed;
    }

    const limit = campaignMaxPartitions();
    const directLimit = campaignDirectMax();
    const kind = planTransport({ partitions: partitions.size, reachable, headerOverride: !!body.headerMediaId });

    return {
      connected,
      total,
      reachable,
      skipped,
      missingByKey: [...missing.values()]
        .sort((a, b) => b.count - a.count || (a.source + a.key < b.source + b.key ? -1 : 1))
        .map((m) => ({ source: m.source, key: m.key, ...fieldLabel(m.source, m.key, defs), count: m.count })),
      split,
      transport: { kind, partitions: partitions.size, limit, directLimit },
      templateMissing,
      templateCheckFailed,
      samples: [sampleSlots.reachable, sampleSlots.fallback, sampleSlots.skipped].filter((s): s is PreviewSample => !!s),
      estimate,
    };
  }

  /**
   * The varMap to preview with: fully validated against the template and
   * this workspace's custom fields when a template is given, the shape only
   * otherwise. A template without placeholders needs no map. No map and
   * placeholders → nothing is resolved (values are not previewed).
   */
  private async loadVarMap(
    workspaceId: string,
    raw: unknown,
    template: { body: string | null } | null,
  ): Promise<{ varMap: VarMap | null; defs: Map<string, CustomDef>; defIds: string[] }> {
    const defs = new Map<string, CustomDef>();
    const slotCount = template ? templatePlaceholderCount(template.body) : 0;
    if (raw === undefined || raw === null) {
      return { varMap: template && slotCount === 0 ? {} : null, defs, defIds: [] };
    }
    const shaped = validateVarMapShape(raw);
    const wantsCustom = slotKeys(shaped).some((k) => shaped[k].source === "custom");
    if (wantsCustom) {
      const rows = (await this.prisma.customFieldDef.findMany({
        where: { workspaceId, entity: "contact", archivedAt: null },
        select: { id: true, key: true, label: true, labelAr: true, type: true, options: true },
      })) as CustomDef[];
      for (const d of rows) defs.set(d.key, d);
    }
    const varMap = template ? validateVarMap(shaped, { slotCount, customDefs: defs }) : shaped;
    const used = new Set(slotKeys(varMap).flatMap((k) => (varMap[k].source === "custom" ? [(varMap[k] as { key: string }).key] : [])));
    const defIds = [...used].flatMap((key) => (defs.has(key) ? [defs.get(key)!.id] : []));
    return { varMap, defs, defIds };
  }

  /** Explicit senders (validated), else the default Zernio WhatsApp number. */
  private async resolveSenders(workspaceId: string, ids: string[]): Promise<PreviewSender[]> {
    if (ids.length > 0) return campaignSenders(this.prisma, workspaceId, ids);
    const def = await campaignSender(this.prisma, workspaceId, null);
    if (!def) return [];
    const ch = def.channelId
      ? await this.prisma.channel.findFirst({ where: { id: def.channelId, workspaceId }, select: { displayName: true, phoneNumber: true } })
      : null;
    return [{ channelId: def.channelId, accountId: def.accountId, displayName: ch?.displayName ?? "WhatsApp", phoneNumber: ch?.phoneNumber ?? null }];
  }

  private skippedSample(
    varMap: VarMap,
    contact: StreamedContact,
    phone: string,
    custom: Record<string, unknown>,
    template: { lang: string; body: string | null },
    defs: Map<string, CustomDef>,
    missing: { source: VarSource; key: string },
  ): PreviewSample {
    const values = slotKeys(varMap).map(
      (k) => resolveSlot(varMap[k], { ...contact, phone }, custom, { lang: template.lang, defs })?.value ?? "",
    );
    return {
      contactId: contact.id,
      name: contact.name,
      rendered: renderTemplate(template.body ?? "", values),
      values,
      usedFallback: [],
      skippedFor: { source: missing.source, key: missing.key },
    };
  }
}
