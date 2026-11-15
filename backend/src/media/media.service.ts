import {
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { mediaError } from "./media-errors";
import { familyOfMime, MIME_OF_FAMILY, sniffFamily, SNIFF_BYTES } from "./sniff";
import { PrismaService } from "../prisma/prisma.service";
import { MEDIA_STORAGE } from "./storage/storage.provider";
import { LocalStorage } from "./storage/local-storage";
import type { MediaStorage } from "./storage/storage.types";
import { PermissionService } from "../permissions/permission.service";
import type { Viewer } from "../permissions/visibility";
import {
  AGENT_PHOTO_MAX_BYTES,
  AGENT_PHOTO_MIMES,
  AGENT_PHOTO_URL_TTL_S,
  approvalBlock,
  normalizeDetails,
  normalizeTag,
  searchTokens,
  type MediaDetailsInput,
} from "./media-details";

const ALLOWED_IMAGE = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
const ALLOWED_VIDEO = new Set(["video/mp4", "video/quicktime"]);
/** Import files live in media storage but are not library assets. */
const ALLOWED_DOCUMENT = new Set([
  "text/csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);
/** SP-13 (ruling 7): library documents. PDF only; no Office, no audio. */
const ALLOWED_PDF = new Set(["application/pdf"]);
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024; // 10 MB (import files)
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB
export const MAX_VIDEO_BYTES = 300 * 1024 * 1024; // 300 MB — IG's ceiling; FB/TikTok allow more
export const MAX_PDF_BYTES = 100 * 1024 * 1024; // 100 MB — WhatsApp's document maximum

/** Every type the library accepts on upload, in the order the error lists them. */
export const LIBRARY_MIME_TYPES = [...ALLOWED_IMAGE, ...ALLOWED_VIDEO, ...ALLOWED_PDF];

/** `all` = every library file (the Gallery). No kind = images and videos (pre-SP-13 pickers). */
export type MediaKind = "image" | "video" | "document" | "all";
export const MEDIA_KINDS: readonly MediaKind[] = ["image", "video", "document", "all"];
const MIME_BY_KIND: Record<MediaKind, string[]> = {
  image: [...ALLOWED_IMAGE],
  video: [...ALLOWED_VIDEO],
  document: [...ALLOWED_PDF],
  all: LIBRARY_MIME_TYPES,
};

/** Library page size: default and maximum (`GET /media?limit=1..200`). */
export const MEDIA_LIST_MAX = 200;
/** Restricted viewers: how many raw pages one request scans to fill a page. */
const MAX_SCAN_PAGES = 20;

/** Campaign statuses whose header file must stay (ruling 10). */
const LIVE_CAMPAIGN_STATUSES = ["draft", "launching", "scheduled", "running"];

/** Advisory-lock key for one media row (SP-13 M1). */
const mediaLockKey = (mediaId: string) => `media:${mediaId}`;

type LockTx = {
  $executeRaw: PrismaService["$executeRaw"];
  media: Pick<PrismaService["media"], "findFirst">;
};

/**
 * SP-13 (M1): serialize a header reference against `MediaService.remove`.
 * Call it inside the `$transaction` that writes a `headerMediaId` (template,
 * campaign), before the write: it takes the same transaction-scoped advisory
 * lock as the delete, then re-reads the row (404 "Media not found" when it was
 * deleted meanwhile, or is not in this workspace). Either the delete sees the
 * new reference and answers 409 media.in_use, or the save sees the row gone.
 */
export async function lockMediaForReference(tx: LockTx, workspaceId: string, mediaId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${mediaLockKey(mediaId)}))`;
  const row = await tx.media.findFirst({ where: { id: mediaId, workspaceId }, select: { id: true } });
  if (!row) throw new NotFoundException("Media not found");
}

/**
 * SP-17 search (ruling 7), shared by `GET /media?q` and the agent's
 * `list_photos`: up to 5 whitespace tokens, every token must match (AND); a
 * token matches when it is contained, case-insensitively, in the title, alt
 * text, "use when" or file name, or equals a (normalised) tag. Arabic matches
 * as typed. `{}` for an empty query. Always ANDed onto the caller's filter.
 */
export function mediaSearchWhere(q: string | null | undefined) {
  const tokens = searchTokens(q);
  if (tokens.length === 0) return {};
  return {
    AND: tokens.map((token) => ({
      OR: [
        { title: { contains: token, mode: "insensitive" as const } },
        { alt: { contains: token, mode: "insensitive" as const } },
        { useWhen: { contains: token, mode: "insensitive" as const } },
        { fileName: { contains: token, mode: "insensitive" as const } },
        { tags: { has: normalizeTag(token) } },
      ],
    })),
  };
}

/** One photo as the agent sees it (no storage path, token, uploader or size). */
export interface AgentPhoto {
  id: string;
  title: string;
  alt: string | null;
  tags: string[];
  useWhen: string | null;
  mimeType: string;
  url: string;
}

/** `list_photos` limit: default and maximum. */
export const AGENT_PHOTO_LIMIT_DEFAULT = 5;
export const AGENT_PHOTO_LIMIT_MAX = 10;

/** The upload cap for a declared library mime type, or null outside the library. */
function capOf(mime: string): number | null {
  if (ALLOWED_IMAGE.has(mime)) return MAX_IMAGE_BYTES;
  if (ALLOWED_VIDEO.has(mime)) return MAX_VIDEO_BYTES;
  if (ALLOWED_PDF.has(mime)) return MAX_PDF_BYTES;
  return null;
}

/** First SNIFF_BYTES of a staged temp file; empty when it can't be read. */
async function readHead(filePath: string): Promise<Buffer> {
  const fs = await import("node:fs/promises");
  let fh: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    fh = await fs.open(filePath, "r");
    const buf = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await fh.read(buf, 0, SNIFF_BYTES, 0);
    return buf.subarray(0, bytesRead);
  } catch {
    return Buffer.alloc(0);
  } finally {
    await fh?.close().catch(() => {});
  }
}

export interface ListOptions {
  kind?: MediaKind;
  before?: string;
  limit?: number;
  /** SP-17: search text (already trimmed by the controller). */
  q?: string;
  /** SP-17: filter by approvedForAgent. */
  approved?: boolean;
}

@Injectable()
export class MediaService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(MEDIA_STORAGE) private readonly storage: MediaStorage,
    @Optional() private readonly perm?: PermissionService,
  ) {}

  /**
   * The library as a plain array (see `listPage`). Kept for callers that
   * don't page.
   */
  async list(
    workspaceId: string,
    viewer?: Viewer,
    opts: ListOptions = {},
  ) {
    return (await this.listPage(workspaceId, viewer, opts)).items;
  }

  /**
   * One page of the library, newest first (`(createdAt, id)` desc). Import
   * files (CSV/XLSX) never appear.
   * - no `kind`: images and videos only, as before SP-13 (the existing
   *   pickers render every row as an image or a video);
   * - `kind`: image | video | document (PDF) | all (all three);
   * - `before`: keyset cursor, a media id of this workspace; only rows
   *   strictly older are returned (400 media.invalid_query {param: "before"}
   *   when unknown or foreign);
   * - `limit` 1..200, default 200;
   * - SP-17 `q`: search (mediaSearchWhere); `approved`: approvedForAgent.
   *
   * `nextBefore` is where the scan stopped: pass it as `before` for the next
   * page. It is null only at the true end of the list, so paging never stops
   * early. A restricted viewer's hidden rows are skipped; when MAX_SCAN_PAGES
   * raw pages are scanned without filling the page, the (possibly short or
   * empty) page returns with the cursor of the last row scanned.
   *
   * Visibility stays in code: it is "a message in a conversation the viewer
   * can see has `attach` containing the id" (a LIKE over messages), which has
   * no cheap SQL join; the cursor makes the cost bounded per request instead.
   */
  async listPage(
    workspaceId: string,
    viewer?: Viewer,
    opts: ListOptions = {},
  ) {
    const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? MEDIA_LIST_MAX)), MEDIA_LIST_MAX);
    // SP-17: `q` and `approved` live in `base`, so the keyset cursor keeps its
    // meaning across the pages of a filtered list (a cursor is a position).
    const base = {
      workspaceId,
      mimeType: { in: opts.kind ? MIME_BY_KIND[opts.kind] : [...ALLOWED_IMAGE, ...ALLOWED_VIDEO] },
      ...(opts.approved !== undefined ? { approvedForAgent: opts.approved } : {}),
      ...mediaSearchWhere(opts.q),
    };

    let cursor: { id: string; createdAt: Date } | null = null;
    if (opts.before) {
      cursor = await this.prisma.media.findFirst({
        where: { id: opts.before, workspaceId },
        select: { id: true, createdAt: true },
      });
      if (!cursor) throw mediaError("media.invalid_query", { param: "before" });
    }

    type Row = Awaited<ReturnType<PrismaService["media"]["findMany"]>>[number];
    const items: Row[] = [];
    for (let page = 0; page < MAX_SCAN_PAGES; page++) {
      // One extra row tells "more exist" from "exactly limit left".
      const fetched: Row[] = await this.prisma.media.findMany({
        where: cursor
          ? {
              AND: [
                base,
                {
                  OR: [
                    { createdAt: { lt: cursor.createdAt } },
                    { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                  ],
                },
              ],
            }
          : base,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
      });
      const hasMore = fetched.length > limit;
      const rows = fetched.slice(0, limit);
      const visible = await this.visibleTo(workspaceId, rows, viewer);
      for (let i = 0; i < rows.length; i++) {
        if (visible && !visible.has(rows[i].id)) continue;
        items.push(rows[i]);
        if (items.length === limit) {
          const more = i < rows.length - 1 || hasMore;
          return { items, nextBefore: more ? rows[i].id : null };
        }
      }
      if (!hasMore) return { items, nextBefore: null };
      const last = rows[rows.length - 1];
      cursor = { id: last.id, createdAt: last.createdAt };
    }
    // Scan budget spent: hand back the position so the client continues.
    return { items, nextBefore: cursor?.id ?? null };
  }

  /**
   * Media ids of `rows` a restricted (assigned-only) viewer may see: staff
   * uploads (uploadedById set) and media referenced by a message in a
   * conversation the viewer can see. Messages reference media by id in
   * `attach`, or by a URL containing the id (public-token links). SP-15: a
   * re-hosted ad creative (AdSource.mediaId) is the business's own ad, shown
   * on the inbox chip, so it is visible like a staff upload. null when the
   * viewer is unrestricted.
   */
  private async visibleTo(
    workspaceId: string,
    rows: { id: string; uploadedById: string | null }[],
    viewer?: Viewer,
  ): Promise<Set<string> | null> {
    if (!this.perm) return null;
    const scope = await this.perm.conversationScope(workspaceId, viewer);
    if (Object.keys(scope).length === 0) return null;
    const out = new Set(rows.filter((r) => r.uploadedById != null).map((r) => r.id));
    let inbound = rows.filter((r) => r.uploadedById == null).map((r) => r.id);
    if (inbound.length > 0) {
      const creatives = await this.prisma.adSource.findMany({
        where: { workspaceId, mediaId: { in: inbound } },
        select: { mediaId: true },
      });
      for (const c of creatives) if (c.mediaId) out.add(c.mediaId);
      inbound = inbound.filter((id) => !out.has(id));
    }
    if (inbound.length > 0) {
      const msgs = await this.prisma.message.findMany({
        where: {
          workspaceId,
          conversation: scope,
          OR: inbound.map((id) => ({ attach: { contains: id } })),
        },
        select: { attach: true },
      });
      for (const id of inbound) if (msgs.some((m) => m.attach?.includes(id))) out.add(id);
    }
    return out;
  }

  /** The row, or 404 when missing or (restricted viewer) not visible. */
  async get(workspaceId: string, id: string, viewer?: Viewer) {
    const row = await this.prisma.media.findFirst({
      where: { id, workspaceId },
    });
    if (!row) throw new NotFoundException("Media not found");
    const visible = await this.visibleTo(workspaceId, [row], viewer);
    if (visible && !visible.has(row.id)) throw new NotFoundException("Media not found");
    return row;
  }

  /**
   * SP-17 `PATCH /media/:id`: edit the details and the agent switch. Loads
   * through `get` (404 for a foreign id, or a file a restricted viewer cannot
   * see). The approval rules (ruling 3) and the title rule (ruling 4) run only
   * when the result is approved and the body approves it or clears the title
   * of an approved row; the agent read path filters older data anyway. Last
   * write wins (ruling 12).
   */
  async update(workspaceId: string, id: string, dto: MediaDetailsInput, viewer?: Viewer) {
    const row = await this.get(workspaceId, id, viewer);
    const data = normalizeDetails(dto ?? {});
    if (Object.keys(data).length === 0) throw mediaError("media.no_changes");
    const merged = { ...row, ...data };
    const approving = data.approvedForAgent === true;
    const clearingTitle = "title" in data && data.title == null;
    if (merged.approvedForAgent && (approving || clearingTitle)) {
      if (approving) {
        const reason = approvalBlock(row);
        if (reason) throw mediaError("media.not_approvable", { reason });
      }
      if (!merged.title) throw mediaError("media.title_required");
    }
    return this.prisma.media.update({ where: { id: row.id, workspaceId }, data });
  }

  /**
   * SP-17 (ruling 1, 3): the photos the AI agent may send, for `list_photos`
   * only. Workspace, approval, photo type and size cap are applied in the
   * query on every call, whatever was true at approval time; the search is
   * ANDed onto them, so a query can never widen the set. Newest first,
   * `limit` 1..10 (default 5). Each url lives AGENT_PHOTO_URL_TTL_S (24 h).
   * No viewer: the MCP token is a workspace credential, and only staff uploads
   * can be approved.
   */
  async listForAgent(
    workspaceId: string,
    opts: { query?: string; tag?: string; limit?: number } = {},
  ): Promise<{ photos: AgentPhoto[] }> {
    const limit = Math.min(
      Math.max(1, Math.floor(opts.limit ?? AGENT_PHOTO_LIMIT_DEFAULT)),
      AGENT_PHOTO_LIMIT_MAX,
    );
    const tag = opts.tag ? normalizeTag(opts.tag) : "";
    const rows = await this.prisma.media.findMany({
      where: {
        AND: [
          {
            workspaceId,
            approvedForAgent: true,
            mimeType: { in: [...AGENT_PHOTO_MIMES] },
            sizeBytes: { lte: AGENT_PHOTO_MAX_BYTES },
          },
          mediaSearchWhere(opts.query),
          tag ? { tags: { has: tag } } : {},
        ],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
    });
    const photos: AgentPhoto[] = [];
    for (const r of rows) {
      photos.push({
        id: r.id,
        title: r.title ?? r.fileName,
        alt: r.alt ?? null,
        tags: r.tags ?? [],
        useWhen: r.useWhen ?? null,
        mimeType: r.mimeType,
        url: await this.resolveExternalUrl(workspaceId, r.id, AGENT_PHOTO_URL_TTL_S),
      });
    }
    return { photos };
  }

  /** Resolve a media row to either a streamable absolute path (legacy local
   *  files) or a signed URL (Spaces, and current-gen local). The controller
   *  branches on whichever value is returned. */
  async resolveServe(
    workspaceId: string,
    id: string,
    ttlSeconds = 3600,
    viewer?: Viewer,
  ): Promise<
    | { kind: "local-file"; absolutePath: string; mimeType: string; fileName?: string }
    | { kind: "signed-url"; url: string; mimeType: string; fileName?: string }
  > {
    const row = await this.get(workspaceId, id, viewer);
    return this.resolveServeForRow(row, ttlSeconds);
  }

  async resolveServeForRow(
    row: { storageKind: string; storedPath: string; mimeType: string; workspaceId: string; fileName?: string | null },
    ttlSeconds = 3600,
  ): Promise<
    | { kind: "local-file"; absolutePath: string; mimeType: string; fileName?: string }
    | { kind: "signed-url"; url: string; mimeType: string; fileName?: string }
  > {
    if (row.storageKind === "spaces") {
      const url = await this.storage.getSignedUrl(row.storedPath, ttlSeconds);
      return { kind: "signed-url", url, mimeType: row.mimeType, fileName: row.fileName ?? undefined };
    }
    // Legacy / local: resolve to an absolute path the controller can sendFile.
    // The storage instance might be SpacesStorage now even though THIS row was
    // written to local disk earlier — fall back to LocalStorage's resolver in
    // that case.
    const local =
      this.storage.kind === "local"
        ? (this.storage as LocalStorage)
        : new LocalStorage();
    const absolutePath = local.resolveAbsolute(row.storedPath);
    if (!absolutePath) {
      throw new NotFoundException("Media path is outside workspace root");
    }
    return { kind: "local-file", absolutePath, mimeType: row.mimeType, fileName: row.fileName ?? undefined };
  }

  /** Read the file bytes for a media row, regardless of which backend stored
   *  it. Used by the social publisher to attach images to Graph/IG/WhatsApp
   *  multipart uploads. */
  async readBuffer(workspaceId: string, id: string): Promise<Buffer> {
    const row = await this.get(workspaceId, id);
    if (row.storageKind === "spaces") {
      const url = await this.storage.getSignedUrl(row.storedPath, 300);
      const resp = await fetch(url);
      if (!resp.ok) {
        throw new NotFoundException(
          `Spaces fetch failed (${resp.status}) for media ${id}`,
        );
      }
      const ab = await resp.arrayBuffer();
      return Buffer.from(ab);
    }
    // Local file
    const local =
      this.storage.kind === "local"
        ? (this.storage as LocalStorage)
        : new LocalStorage();
    const absolutePath = local.resolveAbsolute(row.storedPath);
    if (!absolutePath) {
      throw new NotFoundException("Media path is outside workspace root");
    }
    const fs = await import("node:fs/promises");
    return fs.readFile(absolutePath);
  }

  async finalizeUpload(
    workspaceId: string,
    file: Express.Multer.File,
    uploadedById: string,
  ) {
    if (!file) throw mediaError("media.no_file");
    try {
      // Validation lives inside the try so a rejected upload still hits the
      // finally below — multer's diskStorage has already written file.path
      // to tmpdir by the time we get here, and we must not leak it.
      const cap = capOf(file.mimetype);
      if (cap == null) throw mediaError("media.unsupported_type", { allowed: LIBRARY_MIME_TYPES });
      if (file.size > cap) throw mediaError("media.too_large", { limit: cap });
      // SP-13: never trust the declared type — the bytes must agree with it.
      const head = file.path
        ? await readHead(file.path)
        : (file.buffer ?? Buffer.alloc(0)).subarray(0, SNIFF_BYTES);
      if (sniffFamily(head) !== familyOfMime(file.mimetype)) throw mediaError("media.type_mismatch");
      // Disk-staged uploads (current multer config) hand us file.path; memory
      // uploads (tests, legacy) hand us file.buffer. Storage accepts either.
      const { key } = await this.storage.put({
        workspaceId,
        mimeType: file.mimetype,
        originalFilename: file.originalname,
        ...(file.path ? { sourcePath: file.path } : { buffer: file.buffer }),
      });
      return await this.prisma.media.create({
        data: {
          workspaceId,
          fileName: file.originalname,
          mimeType: file.mimetype,
          sizeBytes: file.size,
          storedPath: key,
          storageKind: this.storage.kind,
          uploadedById,
        },
      });
    } finally {
      if (file.path) {
        const fs = await import("node:fs/promises");
        await fs.unlink(file.path).catch(() => {});
      }
    }
  }

  /**
   * Store bytes we fetched ourselves — inbound webhook attachments, where the
   * provider's own media URL sits behind their auth and can't be loaded by the
   * browser. Re-hosting also means the image survives the provider expiring
   * its link. No uploader: `uploadedById` is nullable for system assets.
   */
  async ingestBuffer(input: {
    workspaceId: string;
    buffer: Buffer;
    mimeType: string;
    fileName: string;
  }) {
    if (!ALLOWED_IMAGE.has(input.mimeType)) {
      throw mediaError("media.unsupported_type", { allowed: [...ALLOWED_IMAGE] });
    }
    if (input.buffer.length > MAX_IMAGE_BYTES) throw mediaError("media.too_large", { limit: MAX_IMAGE_BYTES });
    // SP-13: sniff. Providers often send a fallback type ("image/jpeg" when
    // they don't know), so a real image of another library image family is
    // stored under its sniffed type; anything that is not an image is refused.
    const family = sniffFamily(input.buffer.subarray(0, SNIFF_BYTES));
    const mimeType = family ? MIME_OF_FAMILY[family] : null;
    if (!mimeType || !ALLOWED_IMAGE.has(mimeType)) throw mediaError("media.type_mismatch");
    const { key } = await this.storage.put({
      workspaceId: input.workspaceId,
      buffer: input.buffer,
      mimeType,
      originalFilename: input.fileName,
    });
    return this.prisma.media.create({
      data: {
        workspaceId: input.workspaceId,
        fileName: input.fileName,
        mimeType,
        sizeBytes: input.buffer.length,
        storedPath: key,
        storageKind: this.storage.kind,
        uploadedById: null,
      },
    });
  }

  /**
   * Store an uploaded CSV/XLSX (contacts import). The row is kept out of the
   * media library listing; read it back with readBuffer.
   */
  async ingestDocument(input: {
    workspaceId: string;
    buffer: Buffer;
    mimeType: string;
    fileName: string;
    uploadedById: string;
  }) {
    if (!ALLOWED_DOCUMENT.has(input.mimeType)) {
      throw mediaError("media.unsupported_type", { allowed: [...ALLOWED_DOCUMENT] });
    }
    if (input.buffer.length > MAX_DOCUMENT_BYTES) throw mediaError("media.too_large", { limit: MAX_DOCUMENT_BYTES });
    const { key } = await this.storage.put({
      workspaceId: input.workspaceId,
      buffer: input.buffer,
      mimeType: input.mimeType,
      originalFilename: input.fileName,
    });
    return this.prisma.media.create({
      data: {
        workspaceId: input.workspaceId,
        fileName: input.fileName,
        mimeType: input.mimeType,
        sizeBytes: input.buffer.length,
        storedPath: key,
        storageKind: this.storage.kind,
        uploadedById: input.uploadedById,
      },
    });
  }

  async mintPublicToken(
    workspaceId: string,
    mediaId: string,
    ttlMs = 15 * 60 * 1000,
  ): Promise<string> {
    // SP-13: extend-only. An unexpired token is reused and its expiry only
    // ever moves later, so two senders of one file (two campaigns, a campaign
    // and an inbox send) never invalidate each other's link. Both writes are
    // conditional, so a concurrent mint cannot replace a token another caller
    // has already handed out.
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = await this.get(workspaceId, mediaId);
      const now = Date.now();
      const wanted = new Date(now + ttlMs);
      const current = row.publicTokenExpiresAt?.getTime() ?? 0;
      if (row.publicToken && current > now) {
        if (current < wanted.getTime()) {
          await this.prisma.media.updateMany({
            where: { id: row.id, workspaceId, publicToken: row.publicToken, publicTokenExpiresAt: { lt: wanted } },
            data: { publicTokenExpiresAt: wanted },
          });
        }
        return row.publicToken;
      }
      const token = randomBytes(24).toString("base64url");
      const { count } = await this.prisma.media.updateMany({
        where: { id: row.id, workspaceId, publicToken: row.publicToken ?? null },
        data: { publicToken: token, publicTokenExpiresAt: wanted },
      });
      if (count === 1) return token;
      // Another caller minted in between: loop and reuse theirs.
    }
    throw new Error(`Could not mint a public token for media ${mediaId}`);
  }

  /**
   * Resolve a media row to a URL that an external service (Meta, Twilio, etc.)
   * can fetch directly. Spaces gets a signed S3 URL; local fallback gets a
   * public-token URL routed through our backend (requires PUBLIC_BASE_URL to
   * be reachable from the internet, e.g. via a tunnel in dev).
   */
  async resolveExternalUrl(
    workspaceId: string,
    mediaId: string,
    ttlSeconds = 60 * 60,
  ): Promise<string> {
    const row = await this.get(workspaceId, mediaId);
    if (row.storageKind === "spaces") {
      return this.storage.getSignedUrl(row.storedPath, ttlSeconds);
    }
    // Local storage: mint a public token and build the backend URL.
    const token = await this.mintPublicToken(
      workspaceId,
      mediaId,
      ttlSeconds * 1000,
    );
    const base =
      process.env.PUBLIC_BASE_URL ??
      process.env.APP_BASE_URL ??
      "http://localhost:3001";
    return `${base.replace(/\/$/, "")}/api/media/${mediaId}/public?token=${token}`;
  }

  async findByPublicToken(token: string) {
    if (!token) return null;
    const row = await this.prisma.raw.media.findUnique({
      where: { publicToken: token },
    });
    if (!row) return null;
    if (
      !row.publicTokenExpiresAt ||
      row.publicTokenExpiresAt.getTime() < Date.now()
    ) {
      return null;
    }
    return row;
  }

  /**
   * Delete a file. SP-13 (ruling 10): a file used as the header of a template,
   * or of a campaign that may still send, is refused with 409 media.in_use
   * {templates: {id, name}[], campaigns: {id, name, status}[]}. The FKs are
   * SET NULL as a backstop for a reference added after this check.
   */
  async remove(workspaceId: string, id: string, viewer?: Viewer) {
    const row = await this.get(workspaceId, id, viewer);
    // SP-13 (M1): the reference check and the delete run in one transaction
    // under the media lock that every header save takes (lockMediaForReference),
    // so a reference saved concurrently is either seen here (409) or finds the
    // row gone (404) — never silently nulled by the FK.
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${mediaLockKey(row.id)}))`;
      const templates = await tx.template.findMany({
        where: { workspaceId, headerMediaId: row.id },
        select: { id: true, name: true },
      });
      const campaigns = await tx.campaign.findMany({
        where: { workspaceId, headerMediaId: row.id, status: { in: LIVE_CAMPAIGN_STATUSES } },
        select: { id: true, name: true, status: true },
      });
      if (templates.length > 0 || campaigns.length > 0) {
        throw mediaError("media.in_use", { templates, campaigns });
      }
      await tx.media.delete({ where: { id: row.id } });
    });
    // Delete from whichever backend originally stored it.
    if (row.storageKind === "spaces") {
      await this.storage.delete(row.storedPath);
    } else {
      // Always use a LocalStorage delete for legacy local rows, even if the
      // current backend is Spaces.
      const local =
        this.storage.kind === "local"
          ? (this.storage as LocalStorage)
          : new LocalStorage();
      await local.delete(row.storedPath);
    }
    return { ok: true };
  }
}
