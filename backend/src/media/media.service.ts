import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";

const UPLOAD_ROOT = path.resolve(process.cwd(), "uploads");

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
const MAX_BYTES = 20 * 1024 * 1024; // 20 MB

@Injectable()
export class MediaService {
  constructor(private readonly prisma: PrismaService) {}

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

  /** Resolve a Media row to its absolute disk path. Used by the streaming
   *  endpoint and by the publisher to attach the file to the FB upload. */
  async resolvePath(workspaceId: string, id: string): Promise<string> {
    const row = await this.get(workspaceId, id);
    const absolute = path.resolve(UPLOAD_ROOT, row.storedPath);
    // Defense against path traversal — the stored path must stay under
    // UPLOAD_ROOT/<workspaceId>/.
    const wsRoot = path.resolve(UPLOAD_ROOT, workspaceId);
    if (!absolute.startsWith(wsRoot + path.sep)) {
      throw new InternalServerErrorException("Media path is outside workspace root");
    }
    return absolute;
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
    // Multer wrote the file to disk under uploads/<workspaceId>/<basename>.
    // Store the relative path (relative to UPLOAD_ROOT).
    const storedPath = path
      .relative(UPLOAD_ROOT, file.path)
      .replace(/\\/g, "/");
    return this.prisma.media.create({
      data: {
        workspaceId,
        fileName: file.originalname,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        storedPath,
        uploadedById,
      },
    });
  }

  /** Mint a single-use public token for a media id, valid for `ttlMs`.
   *  Returns the token string. Overwrites any previous public token on
   *  that row, so old links become invalid. */
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

  /** Look up a media row by its public token. Returns null if missing or
   *  expired. Does NOT delete the token — IG publishing fetches the image
   *  a few times during the container poll, so we just expire by time.
   *
   *  Uses the raw unscoped client: this is called from a @Public() route
   *  with no workspace context, and the token itself is the auth. */
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
    // Delete the DB row first; if the file unlink fails we still want the
    // DB to reflect the user's intent. The file will get garbage-collected
    // in a future cleanup pass.
    await this.prisma.media.delete({ where: { id: row.id } });
    try {
      const absolute = path.resolve(UPLOAD_ROOT, row.storedPath);
      await fs.unlink(absolute);
    } catch {
      // Swallow — DB is the source of truth; orphaned bytes are harmless.
    }
    return { ok: true };
  }
}
