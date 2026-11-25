/**
 * SP-29 workspace branding: the logo (an ordinary Media row with
 * `purpose: "brand_logo"`, hidden from the library and the agent) and the
 * public current-logo route, plus the email brand.
 *
 *  - uploadLogo: PNG, JPEG or WebP only, ≤ 2 MB, the bytes must agree with
 *    the declared type (MediaService.finalizeUpload with the logo limits:
 *    `media.unsupported_type` / `media.too_large` / `media.type_mismatch` /
 *    `media.no_file`, nothing stored on a refusal). Then, in one transaction
 *    under the workspace's logo lock (and the new file's media lock): set
 *    `logoMediaId`, audit `workspace.branding_updated`, remember the previous
 *    logo. After commit the previous logo's row and file are deleted when
 *    nothing references them, so concurrent uploads leave exactly one logo.
 *  - serveLogo: only the workspace's CURRENT logo; any other id (a library
 *    file, an old logo, another workspace's logo) is 404. Served with
 *    nosniff, `default-src 'none'` and an immutable cache (a new logo has a
 *    new id, so a new URL).
 */
import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Response } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { lockMediaForReference, MediaService } from "../media/media.service";
import { AuditService } from "../audit/audit.service";
import type { Actor } from "../permissions/permission.service";
import { LOGO_CACHE_CONTROL, LOGO_MAX_BYTES, LOGO_PURPOSE, LOGO_TYPES, logoPath } from "./brand-constants";
import { emailBrandOf, type EmailBrand } from "./email-brand";
export { emailBrandOf, type EmailBrand };

/** The lock every logo change of a workspace takes (serialises concurrent uploads). */
export const logoLockKey = (workspaceId: string) => `workspace-logo:${workspaceId}`;

@Injectable()
export class WorkspaceBrandingService {
  private readonly log = new Logger(WorkspaceBrandingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    private readonly audit: AuditService,
  ) {}

  /** Store a new logo and make it current; returns the workspace row. */
  async uploadLogo(workspaceId: string, file: Express.Multer.File | undefined, actor: Actor) {
    const stored = await this.media.finalizeUpload(workspaceId, file as Express.Multer.File, actor.userId, {
      purpose: LOGO_PURPOSE,
      allowedTypes: LOGO_TYPES,
      maxBytes: LOGO_MAX_BYTES,
    });
    let previous: string | null = null;
    let ws;
    try {
      ws = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${logoLockKey(workspaceId)}))`;
        await lockMediaForReference(tx, workspaceId, stored.id);
        const cur = await tx.workspace.findUnique({ where: { id: workspaceId }, select: { logoMediaId: true } });
        if (!cur) throw new NotFoundException("Workspace not found");
        previous = cur.logoMediaId;
        const updated = await tx.workspace.update({ where: { id: workspaceId }, data: { logoMediaId: stored.id } });
        await this.audit.record(tx, {
          workspaceId,
          actorId: actor.userId,
          action: "workspace.branding_updated",
          targetKind: "workspace",
          targetId: workspaceId,
          meta: { fields: ["logo"] },
        });
        return updated;
      });
    } catch (e) {
      // The new file never became the logo: remove it.
      await this.deleteIfUnreferenced(workspaceId, stored.id);
      throw e;
    }
    if (previous && previous !== stored.id) await this.deleteIfUnreferenced(workspaceId, previous);
    return ws;
  }

  /** Clear the logo and delete its file. Returns the workspace row. */
  async removeLogo(workspaceId: string, actor: Actor) {
    let previous: string | null = null;
    const ws = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${logoLockKey(workspaceId)}))`;
      const cur = await tx.workspace.findUnique({ where: { id: workspaceId }, select: { logoMediaId: true } });
      if (!cur) throw new NotFoundException("Workspace not found");
      previous = cur.logoMediaId;
      const updated = await tx.workspace.update({ where: { id: workspaceId }, data: { logoMediaId: null } });
      if (previous) {
        await this.audit.record(tx, {
          workspaceId,
          actorId: actor.userId,
          action: "workspace.branding_updated",
          targetKind: "workspace",
          targetId: workspaceId,
          meta: { fields: ["logo"] },
        });
      }
      return updated;
    });
    if (previous) await this.deleteIfUnreferenced(workspaceId, previous);
    return ws;
  }

  /**
   * Delete a logo file that is no longer anybody's logo (best effort: a
   * failure leaves an orphan row, never a broken logo). Only purpose-bound
   * logo rows of this workspace are ever deleted here.
   */
  private async deleteIfUnreferenced(workspaceId: string, mediaId: string): Promise<void> {
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        await lockMediaForReference(tx, workspaceId, mediaId);
        const m = await tx.media.findFirst({ where: { id: mediaId, workspaceId, purpose: LOGO_PURPOSE } });
        if (!m) return null;
        const inUse = await tx.workspace.count({ where: { logoMediaId: mediaId } });
        if (inUse > 0) return null;
        await tx.media.deleteMany({ where: { id: mediaId, workspaceId } });
        return m;
      });
      if (row) await this.media.discardStored({ storageKind: row.storageKind, storedPath: row.storedPath });
    } catch {
      this.log.warn(`old logo ${mediaId} could not be deleted`);
    }
  }

  /**
   * GET /branding/:workspaceId/logo/:mediaId (public). Only the workspace's
   * current logo; everything else is the same 404.
   */
  async serveLogo(workspaceId: string, mediaId: string, res: Response): Promise<void> {
    const notFound = () => new NotFoundException("Logo not found");
    if (typeof workspaceId !== "string" || typeof mediaId !== "string" || !workspaceId || !mediaId) throw notFound();
    const ws = await this.prisma.raw.workspace.findUnique({ where: { id: workspaceId }, select: { logoMediaId: true } });
    if (!ws || !ws.logoMediaId || ws.logoMediaId !== mediaId) throw notFound();
    const row = await this.prisma.raw.media.findFirst({ where: { id: mediaId, workspaceId, purpose: LOGO_PURPOSE } });
    if (!row || !(LOGO_TYPES as readonly string[]).includes(row.mimeType)) throw notFound();
    const resolved = await this.media.resolveServeForRow(row);
    // A logo is only ever an image: no script context, whatever the bytes.
    res.setHeader("Content-Security-Policy", "default-src 'none'");
    await this.media.sendResolved(res, resolved, { cacheControl: LOGO_CACHE_CONTROL, label: `logo ${mediaId}` });
  }

  /** The relative public URL of a workspace row's logo, or null. */
  static logoUrlOf(ws: { id: string; logoMediaId?: string | null }): string | null {
    return ws.logoMediaId ? logoPath(ws.id, ws.logoMediaId) : null;
  }

  /** The brand for an email (absolute logo URL from BACKEND_PUBLIC_URL; no logo without it). */
  async emailBrand(workspaceId: string): Promise<EmailBrand | undefined> {
    const ws = await this.prisma.raw.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, name: true, logoMediaId: true, brandColor: true } });
    if (!ws) return undefined;
    return emailBrandOf(ws);
  }
}
