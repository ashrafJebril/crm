import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { MEDIA_STORAGE } from "./storage/storage.provider";
import { LocalStorage } from "./storage/local-storage";
import type { MediaStorage } from "./storage/storage.types";

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
const MAX_BYTES = 20 * 1024 * 1024; // 20 MB

@Injectable()
export class MediaService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(MEDIA_STORAGE) private readonly storage: MediaStorage,
  ) {}

  list(workspaceId: string) {
    return this.prisma.media.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
  }

  async get(workspaceId: string, id: string) {
    const row = await this.prisma.media.findFirst({
      where: { id, workspaceId },
    });
    if (!row) throw new NotFoundException("Media not found");
    return row;
  }

  /** Resolve a media row to either a streamable absolute path (legacy local
   *  files) or a signed URL (Spaces, and current-gen local). The controller
   *  branches on whichever value is returned. */
  async resolveServe(
    workspaceId: string,
    id: string,
    ttlSeconds = 3600,
  ): Promise<
    | { kind: "local-file"; absolutePath: string; mimeType: string }
    | { kind: "signed-url"; url: string; mimeType: string }
  > {
    const row = await this.get(workspaceId, id);
    return this.resolveServeForRow(row, ttlSeconds);
  }

  async resolveServeForRow(
    row: { storageKind: string; storedPath: string; mimeType: string; workspaceId: string },
    ttlSeconds = 3600,
  ): Promise<
    | { kind: "local-file"; absolutePath: string; mimeType: string }
    | { kind: "signed-url"; url: string; mimeType: string }
  > {
    if (row.storageKind === "spaces") {
      const url = await this.storage.getSignedUrl(row.storedPath, ttlSeconds);
      return { kind: "signed-url", url, mimeType: row.mimeType };
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
    return { kind: "local-file", absolutePath, mimeType: row.mimeType };
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
    if (!file) throw new BadRequestException("No file uploaded");
    if (!ALLOWED_MIME.has(file.mimetype)) {
      throw new BadRequestException(
        `Unsupported file type: ${file.mimetype}. Allowed: ${Array.from(ALLOWED_MIME).join(", ")}`,
      );
    }
    if (file.size > MAX_BYTES) {
      throw new BadRequestException(
        `File too large (${file.size} bytes). Max ${MAX_BYTES} bytes.`,
      );
    }
    // multer.memoryStorage puts the bytes on file.buffer.
    const { key } = await this.storage.put({
      workspaceId,
      buffer: file.buffer,
      mimeType: file.mimetype,
      originalFilename: file.originalname,
    });
    return this.prisma.media.create({
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
  }

  async mintPublicToken(
    workspaceId: string,
    mediaId: string,
    ttlMs = 15 * 60 * 1000,
  ): Promise<string> {
    const row = await this.get(workspaceId, mediaId);
    const token = randomBytes(24).toString("base64url");
    const expiresAt = new Date(Date.now() + ttlMs);
    await this.prisma.media.update({
      where: { id: row.id },
      data: { publicToken: token, publicTokenExpiresAt: expiresAt },
    });
    return token;
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

  async remove(workspaceId: string, id: string) {
    const row = await this.get(workspaceId, id);
    await this.prisma.media.delete({ where: { id: row.id } });
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
