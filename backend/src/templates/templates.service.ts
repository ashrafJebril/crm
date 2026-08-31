import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { ZernioClient, ZernioWhatsAppTemplate } from "../integrations/zernio.client";

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
  buttons?: string | null;
  metaTemplateId?: string | null;
  metaRejectionReason?: string | null;
  [key: string]: unknown;
}

export interface CreateTemplateInput {
  name: string;
  lang: string;
  category: string;
  body?: string;
  footer?: string;
  headerType?: string;
  headerContent?: string;
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

    const accountId = await this.whatsappAccountId(workspaceId);
    if (!accountId) return localRows.map((r) => this.unverified(r));

    let metaTemplates: ZernioWhatsAppTemplate[];
    try {
      metaTemplates = await this.client.whatsappTemplates(accountId);
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

  /** Submit a template to Meta (custom) or import a pre-approved library one. */
  async create(workspaceId: string, input: CreateTemplateInput): Promise<TemplateRow> {
    const accountId = await this.whatsappAccountId(workspaceId);
    if (!accountId) {
      throw new BadRequestException(
        "WhatsApp is not connected via Zernio — connect it in Settings → Integrations first. " +
          "Meta has to approve every template, so there is no such thing as a local-only one.",
      );
    }

    const components = input.libraryTemplateName ? undefined : this.buildComponents(input);
    const created = await this.client.createWhatsAppTemplate({
      accountId,
      name: input.name,
      category: this.metaCategory(input.category),
      language: input.lang,
      components,
      libraryTemplateName: input.libraryTemplateName,
    });

    const status = this.mapStatus(created.status);
    const now = new Date();
    return (await this.prisma.template.create({
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
        headerType: input.headerType ?? null,
        headerContent: input.headerContent ?? null,
        buttons:
          input.buttons && input.buttons.length > 0 ? JSON.stringify(input.buttons) : null,
        metaTemplateId: created.id ?? null,
        submittedAt: now,
        reviewedAt: status === "approved" ? now : null,
      },
    })) as unknown as TemplateRow;
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
  ): Promise<TemplateRow> {
    const existing = (await this.prisma.template.findFirst({
      where: { id, workspaceId },
    })) as unknown as TemplateRow | null;
    if (!existing) throw new NotFoundException("Template not found");

    const merged: CreateTemplateInput = {
      name: input.name ?? existing.name,
      lang: input.lang ?? existing.lang,
      category: input.category ?? existing.category,
      body: input.body ?? existing.body ?? undefined,
      footer: input.footer ?? existing.footer ?? undefined,
      headerType: input.headerType ?? existing.headerType ?? undefined,
      headerContent: input.headerContent ?? existing.headerContent ?? undefined,
      buttons: input.buttons,
    };

    const touchesContent =
      input.body !== undefined ||
      input.footer !== undefined ||
      input.headerType !== undefined ||
      input.headerContent !== undefined ||
      input.buttons !== undefined;

    let status = existing.status;
    if (touchesContent && existing.metaTemplateId) {
      const accountId = await this.whatsappAccountId(workspaceId);
      if (!accountId) {
        throw new BadRequestException(
          "WhatsApp is not connected via Zernio — cannot submit the edit to Meta",
        );
      }
      const updated = await this.client.updateWhatsAppTemplate(
        accountId,
        existing.name,
        this.buildComponents(merged),
      );
      status = this.mapStatus(updated.status);
    }

    return (await this.prisma.template.update({
      where: { id },
      data: {
        name: input.name ?? undefined,
        lang: input.lang ?? undefined,
        category: input.category ?? undefined,
        status,
        body: input.body === undefined ? undefined : (input.body ?? null),
        footer: input.footer === undefined ? undefined : (input.footer ?? null),
        headerType: input.headerType === undefined ? undefined : (input.headerType ?? null),
        headerContent:
          input.headerContent === undefined ? undefined : (input.headerContent ?? null),
        buttons:
          input.buttons === undefined
            ? undefined
            : input.buttons.length > 0
              ? JSON.stringify(input.buttons)
              : null,
        ...(touchesContent && existing.metaTemplateId ? { submittedAt: new Date() } : {}),
      },
    })) as unknown as TemplateRow;
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
      const accountId = await this.whatsappAccountId(workspaceId);
      if (accountId) {
        try {
          await this.client.deleteWhatsAppTemplate(accountId, existing.name);
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
    const accountId = await this.whatsappAccountId(workspaceId);
    if (!accountId) {
      throw new BadRequestException("WhatsApp is not connected via Zernio");
    }
    return this.client.whatsappLibraryTemplate(accountId, name, language);
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  private async reconcile(
    workspaceId: string,
    localRows: TemplateRow[],
    metaTemplates: ZernioWhatsAppTemplate[],
  ): Promise<TemplateRow[]> {
    const byKey = new Map(localRows.map((r) => [this.key(r.name, r.lang), r]));
    const confirmed = new Set<string>();
    const out: TemplateRow[] = [];

    for (const m of metaTemplates) {
      const key = this.key(m.name, m.language);
      confirmed.add(key);
      const parts = this.extractComponents(m.components);
      const status = this.mapStatus(m.status);
      const existing = byKey.get(key);

      if (existing) {
        const data = {
          status,
          lang: m.language,
          category: m.category ?? existing.category,
          metaTemplateId: m.id ?? existing.metaTemplateId ?? null,
          // Cleared on anything but a rejection, so an approval doesn't leave
          // a stale reason sitting on the row.
          metaRejectionReason: status === "rejected" ? (m.rejected_reason ?? null) : null,
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
        out.push({ ...existing, ...data });
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
            ...parts,
          },
        })) as unknown as TemplateRow;
        out.push(created);
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
      out.push({ ...r, status: "local", metaTemplateId: null });
    }

    return out;
  }

  /** What we can honestly claim without reaching Meta. */
  private unverified(row: TemplateRow): TemplateRow {
    if (row.metaTemplateId) return row;
    return { ...row, status: "local" };
  }

  private async whatsappAccountId(workspaceId: string): Promise<string | null> {
    const integ = await this.prisma.integration.findFirst({
      where: { workspaceId, provider: "zernio", platform: "whatsapp" },
    });
    return integ?.pageId ?? null;
  }

  /** Match on name + base language so an "en" row links to Meta's "en_US". */
  private key(name: string, language: string): string {
    return `${name}::${String(language ?? "").split(/[_-]/)[0].toLowerCase()}`;
  }

  private mapStatus(metaStatus: string): string {
    switch (String(metaStatus ?? "").toUpperCase()) {
      case "APPROVED":
        return "approved";
      case "REJECTED":
        return "rejected";
      case "PENDING":
      case "IN_APPEAL":
      case "PENDING_DELETION":
        return "pending";
      default:
        return "pending";
    }
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
