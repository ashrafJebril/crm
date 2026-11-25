import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { ZernioClient, ZernioWhatsAppTemplate } from "../integrations/zernio.client";
import { MetaTemplatesClient } from "../integrations/meta-templates.client";
import { decryptSecret } from "../common/token-crypto";
import { defaultMetaWhatsappCredentials, defaultZernioWhatsappAccountId } from "../channels/default-channel";
import { campaignError } from "../campaigns/campaign-errors";
import { lockMediaForReference, MediaService } from "../media/media.service";
import type { Viewer } from "../permissions/visibility";
import { assertHeaderMedia, HEADER_MEDIA_MISMATCH } from "../integrations/template-header";
import { normalizeTemplateQuality } from "../channels/health/health-model";
import { findTemplateCopy, snapshotTemplates } from "../channels/health/template-snapshot";
import { templateError } from "./template-errors";

/**
 * SP-14 (ruling 9): a provider template status → ours, or null when we do
 * not know it. Lowercase like the stored values. PAUSED and DISABLED are
 * their own statuses (a paused template must never look pending);
 * IN_APPEAL and PENDING_DELETION stay pending.
 */
export function knownTemplateStatus(providerStatus: unknown): string | null {
  switch (String(providerStatus ?? "").toUpperCase()) {
    case "APPROVED":
      return "approved";
    case "REJECTED":
      return "rejected";
    case "PAUSED":
      return "paused";
    case "DISABLED":
      return "disabled";
    case "PENDING":
    case "IN_APPEAL":
    case "PENDING_DELETION":
      return "pending";
    default:
      return null;
  }
}

/** Match key for a template: name + base language ("en" links to Meta's "en_US"). */
export function templateKey(name: string, language: string): string {
  return `${name}::${String(language ?? "").split(/[_-]/)[0].toLowerCase()}`;
}

/** A provider's status event for one template (SP-14 webhooks). */
export interface ProviderTemplateStatus {
  /** Meta's template id. */
  templateId?: string | null;
  name?: string | null;
  language?: string | null;
  status?: string | null;
  reason?: string | null;
}

/**
 * SP-14: apply a provider's template status event to this workspace's rows
 * only: by `metaTemplateId` first, else (when `allowNameMatch`) by name and
 * base language. An unknown status changes nothing (it never defaults).
 * Returns the rows updated. Plain Prisma, so the webhook handlers call it
 * without depending on the templates module.
 */
export async function applyTemplateProviderStatus(
  prisma: Pick<PrismaService, "template">,
  workspaceId: string,
  evt: ProviderTemplateStatus,
  opts: { allowNameMatch?: boolean } = {},
): Promise<number> {
  const status = knownTemplateStatus(evt.status);
  if (!status) return 0;
  let rows = evt.templateId
    ? await prisma.template.findMany({ where: { workspaceId, metaTemplateId: String(evt.templateId) } })
    : [];
  if (rows.length === 0 && opts.allowNameMatch && evt.name) {
    const key = templateKey(evt.name, evt.language ?? "");
    rows = (await prisma.template.findMany({ where: { workspaceId, name: evt.name } })).filter(
      (r) => templateKey(r.name, r.lang) === key,
    );
  }
  for (const row of rows) {
    await prisma.template.update({
      where: { id: row.id },
      data: {
        status,
        metaRejectionReason: status === "rejected" ? (evt.reason ?? null) : null,
        reviewedAt: new Date(),
      },
    });
  }
  return rows.length;
}

/** SP-14 `GET /templates/:id/health`: one template's status on every number. */
export interface TemplateHealth {
  template: { id: string; name: string; lang: string; status: string; quality: string | null; reviewedAt: string | null };
  numbers: Array<{
    channelId: string;
    displayName: string;
    phoneNumber: string | null;
    provider: string;
    isDefault: boolean;
    /** Our lowercase status, or "missing" (the known snapshot lacks it) or "unknown". */
    status: string;
    /** GREEN | YELLOW | RED | NOT_RATED, or "unknown". */
    quality: string;
    checkedAt: string | null;
  }>;
}

/**
 * Where a workspace's templates live: the Zernio account of its default
 * WhatsApp number, or the WABA of a number connected directly to Meta. Both
 * speak Meta's template model; only Zernio proxies Meta's template library.
 */
interface TemplateBackend {
  kind: "zernio" | "meta";
  list(): Promise<ZernioWhatsAppTemplate[]>;
  create(body: {
    name: string;
    category: "AUTHENTICATION" | "MARKETING" | "UTILITY";
    language: string;
    components?: Array<Record<string, unknown>>;
    libraryTemplateName?: string;
  }): Promise<{ id: string | null; status: string; language?: string }>;
  update(
    name: string,
    metaTemplateId: string,
    components: Array<Record<string, unknown>>,
  ): Promise<{ status: string }>;
  remove(name: string, metaTemplateId: string | null): Promise<void>;
  library(name: string, language?: string): Promise<unknown>;
}

/** SP-13 (M3): a media header needs a file (or a legacy sample URL). */
export const HEADER_MEDIA_REQUIRED = "templates.header_media_required";

const MEDIA_HEADER_TYPES = new Set(["image", "video", "document"]);

/**
 * WhatsApp message templates.
 *
 * Meta owns the truth here: a template only exists, and can only be sent, once
 * Meta has approved it on the WABA. Zernio proxies the WhatsApp Cloud API, so
 * its list IS Meta's verdict — this service reconciles our local rows against
 * it on every read.
 *
 * History worth keeping: the previous version stored `status: "approved"` on
 * any row it failed to submit, and the demo seed did the same. The Templates
 * screen therefore advertised four approved templates that Meta had never
 * heard of, and every send failed with a 404. A row we cannot verify now
 * reports `local` — never `approved`.
 */

/** Loose row shape — covers Prisma rows and the objects we synthesize. */
export interface TemplateRow {
  id: string;
  name: string;
  lang: string;
  category: string;
  status: string;
  uses: number;
  body?: string | null;
  footer?: string | null;
  headerType?: string | null;
  headerContent?: string | null;
  /** SP-13: the library file used as the media header's sample. */
  headerMediaId?: string | null;
  buttons?: string | null;
  metaTemplateId?: string | null;
  metaRejectionReason?: string | null;
  /** SP-14: Meta's template quality (GREEN | YELLOW | RED | NOT_RATED); null = unknown. */
  quality?: string | null;
  /**
   * Final review M5 (response only, not stored): where `quality` came from.
   * "zernio_passthrough" when the Zernio list just read carried the score
   * (an undocumented field, R1); null when it carried none.
   */
  qualitySource?: "zernio_passthrough" | null;
  /**
   * Final review M5 (response only): when the provider list confirming
   * `quality` was read; null when this response is not from a fresh read
   * (a failed or impossible list read), so a stored quality is only a
   * previous value.
   */
  qualityReadAt?: string | null;
  [key: string]: unknown;
}

export interface CreateTemplateInput {
  name: string;
  lang: string;
  category: string;
  body?: string;
  footer?: string;
  /** "none" | "text" | "image" | "video" | "document". "none" = no header. */
  headerType?: string;
  /** Text headers only (a legacy media header may still carry a public URL). */
  headerContent?: string;
  /**
   * SP-13: library file for an image/video/document header. Resolved through
   * MediaService.get with the viewer (404 when foreign or hidden), checked
   * against the header kind and WhatsApp's limits, and submitted to Meta as
   * `header_handle` (a 1 h link). null on update clears it.
   */
  headerMediaId?: string | null;
  buttons?: Array<Record<string, unknown>>;
  /**
   * Sample values for the body's {{n}} placeholders, in order. Meta REJECTS a
   * template whose variables carry no samples, so when this is absent we
   * generate placeholders rather than submit something certain to fail.
   */
  bodyExamples?: string[];
  /** Sample values for a text header's {{n}} placeholders. */
  headerExamples?: string[];
  /** Use a pre-approved template from Meta's library instead of our own components. */
  libraryTemplateName?: string;
}

/**
 * Where a workspace's templates live: its Zernio WhatsApp account, or the WABA
 * of a number connected directly to Meta. Both speak Meta's template model.
 */
interface TemplateBackend {
  kind: "zernio" | "meta";
  list(): Promise<ZernioWhatsAppTemplate[]>;
  create(body: {
    name: string;
    category: "AUTHENTICATION" | "MARKETING" | "UTILITY";
    language: string;
    components?: Array<Record<string, unknown>>;
    libraryTemplateName?: string;
  }): Promise<{ id: string | null; status: string; language?: string }>;
  update(
    name: string,
    metaTemplateId: string,
    components: Array<Record<string, unknown>>,
  ): Promise<{ status: string }>;
  remove(name: string, metaTemplateId: string | null): Promise<void>;
}

const NOT_CONNECTED =
  "WhatsApp is not connected — connect it in Settings → Integrations first. " +
  "Meta has to approve every template, so there is no such thing as a local-only one.";

/** Meta component pieces, flattened onto our columns. */
interface ExtractedComponents {
  body: string | null;
  footer: string | null;
  headerType: string | null;
  headerContent: string | null;
  buttons: string | null;
}

@Injectable()
export class TemplatesService {
  private readonly log = new Logger(TemplatesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: ZernioClient,
    @Optional() private readonly media?: MediaService,
    private readonly meta: MetaTemplatesClient = new MetaTemplatesClient(),
  ) {}

  /**
   * List templates, reconciled against Meta.
   *
   * Reads write: confirming a template against Meta persists its real status,
   * id and components, the same way `ZernioService.syncAccounts` treats Zernio
   * as the source of truth for connected accounts.
   */
  async list(workspaceId: string): Promise<TemplateRow[]> {
    const localRows = (await this.prisma.template.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
    })) as unknown as TemplateRow[];

    const backend = await this.backend(workspaceId);
    if (!backend) return localRows.map((r) => this.unverified(r));

    let metaTemplates: ZernioWhatsAppTemplate[];
    try {
      metaTemplates = await backend.list();
    } catch (e) {
      // An outage must not resurrect the fiction — fall back to what we can
      // honestly say, which is "confirmed before" or "local".
      this.log.warn(
        `template list ws=${workspaceId} falling back to local rows: ${(e as Error).message}`,
      );
      return localRows.map((r) => this.unverified(r));
    }

    return this.reconcile(workspaceId, localRows, metaTemplates);
  }

  /**
   * SP-14: reconcile against a templates list the caller already read from
   * the default number (the health sweep), so no extra Zernio call is made.
   */
  async reconcileFromList(workspaceId: string, metaTemplates: ZernioWhatsAppTemplate[]): Promise<TemplateRow[]> {
    const localRows = (await this.prisma.template.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
    })) as unknown as TemplateRow[];
    return this.reconcile(workspaceId, localRows, metaTemplates);
  }

  /** SP-14: apply a provider status event to this workspace's rows (see `applyTemplateProviderStatus`). */
  applyProviderStatus(workspaceId: string, evt: ProviderTemplateStatus, opts: { allowNameMatch?: boolean } = {}): Promise<number> {
    return applyTemplateProviderStatus(this.prisma, workspaceId, evt, opts);
  }

  /**
   * SP-14 `GET /templates/:id/health`: the template's status on every
   * non-disconnected WhatsApp number of the workspace, from each number's
   * health snapshot (no provider call). Matching is by name and base
   * language. `missing`: the snapshot's list is known, complete and lacks
   * it. `unknown`: no snapshot, an unknown list, or a truncated list that
   * lacks it. Foreign or unknown id → 404 `templates.not_found`.
   */
  async healthFor(workspaceId: string, id: string): Promise<TemplateHealth> {
    const row = (await this.prisma.template.findFirst({ where: { id, workspaceId } })) as unknown as TemplateRow | null;
    if (!row) throw templateError("templates.not_found");
    const channels = (await this.prisma.channel.findMany({
      where: { workspaceId, kind: "whatsapp", status: { not: "disconnected" } },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
      select: { id: true, displayName: true, phoneNumber: true, provider: true, externalId: true, isDefault: true, health: true },
    })) as Array<{
      id: string;
      displayName: string;
      phoneNumber: string | null;
      provider: string;
      externalId: string | null;
      isDefault: boolean;
      health: unknown;
    }>;
    const reviewed = row.reviewedAt as unknown;
    const reviewedAt = reviewed instanceof Date ? reviewed.toISOString() : typeof reviewed === "string" ? reviewed : null;
    return {
      template: { id: row.id, name: row.name, lang: row.lang, status: row.status, quality: row.quality ?? null, reviewedAt },
      numbers: channels.map((ch) => {
        const snap = snapshotTemplates(ch.id, ch.health, { provider: ch.provider, externalId: ch.externalId ?? null });
        const copy = snap.known ? findTemplateCopy(snap.items, row.name, row.lang) : null;
        const status = copy
          ? (knownTemplateStatus(copy.status) ?? String(copy.status).toLowerCase())
          : snap.known && !snap.truncated
            ? "missing"
            : "unknown";
        return {
          channelId: ch.id,
          displayName: ch.displayName,
          phoneNumber: ch.phoneNumber ?? null,
          provider: ch.provider,
          isDefault: ch.isDefault === true,
          status,
          quality: copy?.quality ?? "unknown",
          checkedAt: snap.checkedAt,
        };
      }),
    };
  }

  /** Submit a template to Meta (custom) or import a pre-approved library one. */
  async create(workspaceId: string, input: CreateTemplateInput, viewer?: Viewer): Promise<TemplateRow> {
    const header = this.normalizeHeader(input.headerType, input.headerContent, input.headerMediaId ?? null);
    // Validate the header file before anything reaches Meta (404 / mismatch / too large).
    await this.checkHeaderMedia(workspaceId, header, viewer);
    const backend = await this.backend(workspaceId);
    // Meta has to approve every template, so there is no such thing as a
    // local-only one. SP-13 ruling 6: one keyed 409 for every marketing action.
    if (!backend) throw campaignError("campaigns.whatsapp_not_connected");
    this.assertSupported(backend, input);

    const components = input.libraryTemplateName
      ? undefined
      : this.buildComponents({ ...input, ...(await this.submittable(workspaceId, header)) });
    const created = await backend.create({
      name: input.name,
      category: this.metaCategory(input.category),
      language: input.lang,
      components,
      libraryTemplateName: input.libraryTemplateName,
    });

    const status = this.mapStatus(created.status);
    const now = new Date();
    return (await this.writeWithHeaderLock(workspaceId, header.headerMediaId, (db) => db.template.create({
      data: {
        workspaceId,
        name: input.name,
        // Meta's exact language code, so sends resolve the right variant.
        lang: created.language ?? input.lang,
        category: input.category,
        status,
        uses: 0,
        body: input.body ?? null,
        footer: input.footer ?? null,
        headerType: header.headerType,
        headerContent: header.headerContent,
        headerMediaId: header.headerMediaId,
        buttons:
          input.buttons && input.buttons.length > 0 ? JSON.stringify(input.buttons) : null,
        metaTemplateId: created.id ?? null,
        submittedAt: now,
        reviewedAt: status === "approved" ? now : null,
      },
    }))) as unknown as TemplateRow;
  }

  /**
   * Edit a template.
   *
   * A content change on a Meta-known template goes to Meta, which re-reviews
   * it (status → pending). Editing only our columns would be pointless: the
   * next `list()` reconciliation overwrites them from Meta's components, so a
   * local edit would silently vanish. Rows Meta has never seen edit locally.
   */
  async update(
    workspaceId: string,
    id: string,
    input: Partial<CreateTemplateInput>,
    viewer?: Viewer,
  ): Promise<TemplateRow> {
    const existing = (await this.prisma.template.findFirst({
      where: { id, workspaceId },
    })) as unknown as TemplateRow | null;
    if (!existing) throw new NotFoundException("Template not found");

    const touchesHeader =
      input.headerType !== undefined ||
      input.headerContent !== undefined ||
      input.headerMediaId !== undefined;
    // The header after this edit. A file id is kept unless replaced, cleared,
    // or the header type changes.
    const typeChanged =
      input.headerType !== undefined &&
      input.headerType.toLowerCase() !== String(existing.headerType ?? "").toLowerCase();
    const header = touchesHeader
      ? this.normalizeHeader(
          input.headerType ?? existing.headerType ?? undefined,
          input.headerContent !== undefined
            ? input.headerContent
            : typeChanged
              ? undefined
              : (existing.headerContent ?? undefined),
          input.headerMediaId !== undefined
            ? input.headerMediaId
            : typeChanged
              ? null
              : (existing.headerMediaId ?? null),
        )
      : {
          headerType: existing.headerType ?? null,
          headerContent: existing.headerContent ?? null,
          headerMediaId: existing.headerMediaId ?? null,
        };
    if (touchesHeader) await this.checkHeaderMedia(workspaceId, header, viewer);

    const merged: CreateTemplateInput = {
      name: input.name ?? existing.name,
      lang: input.lang ?? existing.lang,
      category: input.category ?? existing.category,
      body: input.body ?? existing.body ?? undefined,
      footer: input.footer ?? existing.footer ?? undefined,
      buttons: input.buttons,
    };

    const touchesContent =
      input.body !== undefined ||
      input.footer !== undefined ||
      touchesHeader ||
      input.buttons !== undefined;

    let status = existing.status;
    if (touchesContent && existing.metaTemplateId) {
      const backend = await this.backend(workspaceId);
      // SP-13 ruling 6: the edit has to reach Meta.
      if (!backend) throw campaignError("campaigns.whatsapp_not_connected");
      this.assertSupported(backend, merged);
      const updated = await backend.update(
        existing.name,
        existing.metaTemplateId,
        this.buildComponents({ ...merged, ...(await this.submittable(workspaceId, header)) }),
      );
      status = this.mapStatus(updated.status);
    }

    const lockId = touchesHeader ? header.headerMediaId : null;
    return (await this.writeWithHeaderLock(workspaceId, lockId, (db) => db.template.update({
      where: { id },
      data: {
        name: input.name ?? undefined,
        lang: input.lang ?? undefined,
        category: input.category ?? undefined,
        status,
        body: input.body === undefined ? undefined : (input.body ?? null),
        footer: input.footer === undefined ? undefined : (input.footer ?? null),
        ...(touchesHeader
          ? {
              headerType: header.headerType,
              headerContent: header.headerContent,
              headerMediaId: header.headerMediaId,
            }
          : {}),
        buttons:
          input.buttons === undefined
            ? undefined
            : input.buttons.length > 0
              ? JSON.stringify(input.buttons)
              : null,
        ...(touchesContent && existing.metaTemplateId ? { submittedAt: new Date() } : {}),
      },
    }))) as unknown as TemplateRow;
  }

  /**
   * Copy a template. The copy is `local`: Meta approves a template by NAME, so
   * a differently-named copy carries no approval of its own until submitted.
   */
  async duplicate(workspaceId: string, id: string): Promise<TemplateRow> {
    const src = (await this.prisma.template.findFirst({
      where: { id, workspaceId },
    })) as unknown as TemplateRow | null;
    if (!src) throw new NotFoundException("Template not found");

    return (await this.prisma.template.create({
      data: {
        workspaceId,
        name: `${src.name}_copy`,
        lang: src.lang,
        category: src.category,
        status: "local",
        uses: 0,
        body: src.body ?? null,
        footer: src.footer ?? null,
        headerType: src.headerType ?? null,
        headerContent: src.headerContent ?? null,
        headerMediaId: src.headerMediaId ?? null,
        buttons: src.buttons ?? null,
        metaTemplateId: null,
      },
    })) as unknown as TemplateRow;
  }

  /**
   * Delete a template — at Meta too when Meta knows it.
   *
   * Dropping only our row would be a no-op the user cannot see: the next
   * `list()` reconciliation re-imports the template straight back from Meta.
   */
  async remove(workspaceId: string, id: string): Promise<{ ok: true }> {
    const existing = (await this.prisma.template.findFirst({
      where: { id, workspaceId },
    })) as unknown as TemplateRow | null;
    if (!existing) throw new NotFoundException("Template not found");

    if (existing.metaTemplateId) {
      const backend = await this.backend(workspaceId);
      if (backend) {
        try {
          await backend.remove(existing.name, existing.metaTemplateId);
        } catch (e) {
          throw new BadRequestException(
            `Could not delete the template at Meta: ${(e as Error).message}`,
          );
        }
      }
    }
    await this.prisma.template.delete({ where: { id } });
    return { ok: true };
  }

  /**
   * Look up a pre-approved library template so the caller can see its body and
   * which button inputs Meta will demand. A library template with URL or
   * PHONE_NUMBER buttons must be created with matching button inputs or Meta
   * rejects it.
   */
  async lookupLibraryTemplate(workspaceId: string, name: string, language?: string) {
    const backend = await this.backend(workspaceId);
    if (!backend) throw campaignError("campaigns.whatsapp_not_connected");
    if (backend.kind !== "zernio") {
      throw new BadRequestException(
        "Meta's template library is only available for WhatsApp connected via Zernio",
      );
    }
    return backend.library(name, language);
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  /**
   * The stored header columns for an input. "none" (or no type) clears all
   * three; a text header keeps only its text; a media header keeps its file
   * id (or, for a legacy caller without one, the URL in headerContent).
   * A file id on a text or no header is a mismatch.
   */
  private normalizeHeader(
    headerType: string | undefined | null,
    headerContent: string | undefined | null,
    headerMediaId: string | null,
  ): { headerType: string | null; headerContent: string | null; headerMediaId: string | null } {
    const type = headerType ? headerType.toLowerCase() : null;
    const isMedia = !!type && MEDIA_HEADER_TYPES.has(type);
    if (headerMediaId && !isMedia) throw new BadRequestException(HEADER_MEDIA_MISMATCH);
    if (!type || type === "none") return { headerType: null, headerContent: null, headerMediaId: null };
    if (!isMedia) return { headerType: type, headerContent: headerContent ?? null, headerMediaId: null };
    if (headerMediaId) return { headerType: type, headerContent: null, headerMediaId };
    // No file and no legacy sample URL: Meta would get `header_handle: [""]`.
    if (!headerContent?.trim()) {
      throw new BadRequestException({ statusCode: 400, message: HEADER_MEDIA_REQUIRED });
    }
    return { headerType: type, headerContent, headerMediaId: null };
  }

  /**
   * Run the template write. With a header file it runs in a transaction that
   * first takes the media lock (`lockMediaForReference`, shared with
   * `MediaService.remove`) and re-reads the file, so a concurrent delete
   * either sees this reference (409 media.in_use) or this save sees the file
   * gone (404) instead of the FK silently nulling it.
   */
  private async writeWithHeaderLock<T>(
    workspaceId: string,
    mediaId: string | null,
    write: (db: Pick<PrismaService, "template">) => Promise<T>,
  ): Promise<T> {
    if (!mediaId) return write(this.prisma);
    return this.prisma.$transaction(async (tx) => {
      await lockMediaForReference(tx, workspaceId, mediaId);
      return write(tx as unknown as Pick<PrismaService, "template">);
    });
  }

  /** The header file: workspace- and viewer-scoped (404), kind and size checked. */
  private async checkHeaderMedia(
    workspaceId: string,
    header: { headerType: string | null; headerMediaId: string | null },
    viewer?: Viewer,
  ): Promise<void> {
    if (!header.headerMediaId) return;
    if (!this.media) throw new Error("TemplatesService: MediaService is required for header files");
    const row = await this.media.get(workspaceId, header.headerMediaId, viewer);
    assertHeaderMedia(row, header.headerType);
  }

  /**
   * What buildComponents submits for the header: a library file becomes a
   * 1 h external link (Zernio downloads it and swaps in Meta's handle).
   */
  private async submittable(
    workspaceId: string,
    header: { headerType: string | null; headerContent: string | null; headerMediaId: string | null },
  ): Promise<{ headerType?: string; headerContent?: string }> {
    let content = header.headerContent ?? undefined;
    if (header.headerMediaId) {
      if (!this.media) throw new Error("TemplatesService: MediaService is required for header files");
      content = await this.media.resolveExternalUrl(workspaceId, header.headerMediaId, 3600);
    }
    return { headerType: header.headerType ?? undefined, headerContent: content };
  }

  private async reconcile(
    workspaceId: string,
    localRows: TemplateRow[],
    metaTemplates: ZernioWhatsAppTemplate[],
  ): Promise<TemplateRow[]> {
    const byKey = new Map(localRows.map((r) => [this.key(r.name, r.lang), r]));
    const confirmed = new Set<string>();
    const out: TemplateRow[] = [];
    const readAt = new Date().toISOString();

    for (const m of metaTemplates) {
      const key = this.key(m.name, m.language);
      confirmed.add(key);
      const parts = this.extractComponents(m.components);
      const status = this.mapStatus(m.status);
      const existing = byKey.get(key);
      // SP-14: Meta's template quality when the list carries it (UNKNOWN →
      // NOT_RATED). Final review M5 (R1): absent or unrecognised clears the
      // stored value — a score the provider no longer reports is not kept as
      // current. (A value from Meta's quality webhook lasts until the next
      // list read without a score.)
      const quality = normalizeTemplateQuality(m.quality_score?.score);
      const qualityPart = quality ? { quality } : {};
      const qualityMeta = { qualitySource: quality ? ("zernio_passthrough" as const) : null, qualityReadAt: readAt };

      if (existing) {
        const data = {
          status,
          lang: m.language,
          category: m.category ?? existing.category,
          metaTemplateId: m.id ?? existing.metaTemplateId ?? null,
          // Cleared on anything but a rejection, so an approval doesn't leave
          // a stale reason sitting on the row.
          metaRejectionReason: status === "rejected" ? (m.rejected_reason ?? null) : null,
          quality: quality ?? null,
          ...parts,
        };
        // list() runs on every screen load, so only write when Meta actually
        // disagrees with what we stored — otherwise this is N pointless
        // UPDATEs on a pure read.
        const changed = (Object.keys(data) as Array<keyof typeof data>).some(
          (k) => (existing[k] ?? null) !== (data[k] ?? null),
        );
        if (changed) {
          await this.prisma.template.update({
            where: { id: existing.id },
            data: { ...data, reviewedAt: new Date() },
          });
        }
        out.push({ ...existing, ...data, ...qualityMeta });
      } else {
        const created = (await this.prisma.template.create({
          data: {
            workspaceId,
            name: m.name,
            lang: m.language,
            category: m.category ?? "UTILITY",
            status,
            uses: 0,
            metaTemplateId: m.id ?? null,
            metaRejectionReason: status === "rejected" ? (m.rejected_reason ?? null) : null,
            reviewedAt: new Date(),
            ...qualityPart,
            ...parts,
          },
        })) as unknown as TemplateRow;
        out.push({ ...created, ...qualityMeta });
      }
    }

    // Anything Meta does not list cannot be sent. Say so, and clear any stale
    // Meta id so a later outage doesn't read it as "confirmed before".
    for (const r of localRows) {
      if (confirmed.has(this.key(r.name, r.lang))) continue;
      if (r.status !== "local" || r.metaTemplateId) {
        await this.prisma.template.update({
          where: { id: r.id },
          data: { status: "local", metaTemplateId: null },
        });
      }
      out.push({ ...r, status: "local", metaTemplateId: null, qualitySource: null, qualityReadAt: null });
    }

    return out;
  }

  /** What we can honestly claim without reaching Meta. */
  private unverified(row: TemplateRow): TemplateRow {
    // M5: not read now, so a stored quality is only a previous value.
    const quality = { qualitySource: null, qualityReadAt: null };
    if (row.metaTemplateId) return { ...row, ...quality };
    return { ...row, status: "local", ...quality };
  }

  /**
   * Where this workspace's templates live — its default WhatsApp number
   * (SP-19 R8). Zernio numbers go through Zernio's proxy; a number connected
   * directly to Meta goes straight to its WABA. null when no connected
   * number can carry a template.
   */
  private async backend(workspaceId: string): Promise<TemplateBackend | null> {
    const accountId = await this.whatsappAccountId(workspaceId);
    if (accountId) {
      return {
        kind: "zernio",
        list: () => this.client.whatsappTemplates(accountId),
        create: (body) => this.client.createWhatsAppTemplate({ accountId, ...body }),
        update: (name, _id, components) => this.client.updateWhatsAppTemplate(accountId, name, components),
        remove: (name) => this.client.deleteWhatsAppTemplate(accountId, name),
        library: (name, language) => this.client.whatsappLibraryTemplate(accountId, name, language),
      };
    }

    const creds = await defaultMetaWhatsappCredentials(this.prisma, workspaceId);
    if (!creds) return null;
    const waba = { token: creds.token, wabaId: creds.wabaId };
    return {
      kind: "meta",
      list: () => this.meta.list(waba),
      create: (body) => this.meta.create(waba, body),
      update: (_name, id, components) => this.meta.update(waba, id, components),
      remove: (name, id) => this.meta.remove(waba, name, id),
      library: () => {
        throw new BadRequestException(
          "Meta's template library is only available for WhatsApp connected via Zernio",
        );
      },
    };
  }

  /** SP-19 (R8): Zernio templates live on the default WhatsApp number. */
  private async whatsappAccountId(workspaceId: string): Promise<string | null> {
    return defaultZernioWhatsappAccountId(this.prisma, workspaceId);
  }

  /**
   * Zernio turns a media header's public URL into Meta's upload handle for us.
   * On a direct connection Meta wants that handle (a resumable upload), which
   * we don't do yet — refuse clearly instead of letting Meta 400 obscurely.
   */
  private assertSupported(backend: TemplateBackend, input: Partial<CreateTemplateInput>) {
    if (backend.kind !== "meta") return;
    if (input.libraryTemplateName) return;
    const header = input.headerType?.toLowerCase();
    if (header && header !== "text") {
      throw new BadRequestException(
        "Image, video and document headers aren't supported yet on a WhatsApp number connected directly to Meta. Use a text header or none.",
      );
    }
  }

  /** Match on name + base language so an "en" row links to Meta's "en_US". */
  private key(name: string, language: string): string {
    return templateKey(name, language);
  }

  /** SP-14 (ruling 9): PAUSED → paused, DISABLED → disabled; anything unknown stays `pending`. */
  mapStatus(metaStatus: string): string {
    return knownTemplateStatus(metaStatus) ?? "pending";
  }

  /**
   * Meta retired TRANSACTIONAL — it only accepts AUTHENTICATION, MARKETING and
   * UTILITY. Our older rows (and the demo seed) still say TRANSACTIONAL, which
   * Meta 400s on, so it maps to UTILITY on the way out.
   */
  private metaCategory(category: string): "AUTHENTICATION" | "MARKETING" | "UTILITY" {
    const c = String(category ?? "").toUpperCase();
    if (c === "AUTHENTICATION" || c === "MARKETING" || c === "UTILITY") return c;
    return "UTILITY";
  }

  /**
   * Our columns → Zernio's component array, in Meta's required order
   * (header, body, footer, buttons).
   *
   * Every discriminator here is LOWERCASE. Zernio validates `type` against
   * `'header' | 'body' | 'footer' | 'buttons' | 'limited_time_offer' |
   * 'carousel'`, the header `format` against `'text' | 'image' | 'video' |
   * 'gif' | 'document' | 'location'`, and a button `type` against
   * `'quick_reply' | 'url' | 'phone_number' | ...`. Meta's own docs show these
   * uppercase, and sending uppercase fails with "Invalid discriminator value"
   * (hit live 2026-08-28). The UI supplies button types uppercase, so they are
   * normalized here rather than at the edge.
   */
  private buildComponents(input: CreateTemplateInput): Array<Record<string, unknown>> {
    const components: Array<Record<string, unknown>> = [];
    if (input.headerType) {
      const format = input.headerType.toLowerCase();
      if (format === "text") {
        const text = input.headerContent ?? "";
        const samples = this.samplesFor(text, input.headerExamples);
        components.push({
          type: "header",
          format,
          text,
          ...(samples.length > 0 ? { example: { header_text: samples } } : {}),
        });
      } else {
        components.push({
          type: "header",
          format,
          // Zernio downloads this public URL and swaps in Meta's internal
          // file handle before creating the template.
          example: { header_handle: [input.headerContent ?? ""] },
        });
      }
    }
    if (input.body) {
      const samples = this.samplesFor(input.body, input.bodyExamples);
      components.push({
        type: "body",
        text: input.body,
        // body_text is an array of arrays: one inner array per variable set.
        ...(samples.length > 0 ? { example: { body_text: [samples] } } : {}),
      });
    }
    if (input.footer) components.push({ type: "footer", text: input.footer });
    if (input.buttons && input.buttons.length > 0) {
      components.push({
        type: "buttons",
        buttons: input.buttons.map((b) => ({
          ...b,
          type: String(b.type ?? "").toLowerCase(),
        })),
      });
    }
    return components;
  }

  /**
   * Sample values for every distinct {{n}} placeholder in `text`.
   *
   * Meta rejects a template whose variables have no samples, so a caller that
   * supplies none still gets placeholders — a generated sample is reviewable,
   * an absent one is an instant rejection. Caller-supplied values win, and are
   * padded/trimmed to the placeholder count so a mismatch can't 400.
   */
  private samplesFor(text: string, supplied?: string[]): string[] {
    const positions = new Set<string>();
    for (const m of text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) positions.add(m[1]);
    const count = positions.size;
    if (count === 0) return [];
    return Array.from({ length: count }, (_, i) => supplied?.[i]?.trim() || `sample${i + 1}`);
  }

  /** Meta's component array → our flat columns. */
  private extractComponents(
    components?: Array<Record<string, unknown>>,
  ): ExtractedComponents {
    const out: ExtractedComponents = {
      body: null,
      footer: null,
      headerType: null,
      headerContent: null,
      buttons: null,
    };
    for (const c of components ?? []) {
      switch (String(c.type ?? "").toUpperCase()) {
        case "BODY":
          out.body = (c.text as string) ?? null;
          break;
        case "FOOTER":
          out.footer = (c.text as string) ?? null;
          break;
        case "HEADER":
          out.headerType = String(c.format ?? "text").toLowerCase();
          out.headerContent = (c.text as string) ?? null;
          break;
        case "BUTTONS": {
          const buttons = c.buttons as unknown[] | undefined;
          out.buttons = buttons && buttons.length > 0 ? JSON.stringify(buttons) : null;
          break;
        }
      }
    }
    return out;
  }
}
