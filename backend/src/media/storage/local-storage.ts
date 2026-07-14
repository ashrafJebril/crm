import { Injectable, Logger } from "@nestjs/common";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type { MediaStorage } from "./storage.types";

const UPLOAD_ROOT = path.resolve(process.cwd(), "uploads");

/** Filesystem-backed implementation. Used in dev / single-instance deploys
 *  where mounting a persistent volume is fine and Spaces credentials aren't
 *  configured. Keys are stored as `<workspaceId>/<random-hex><ext>`, relative
 *  to backend/uploads. */
@Injectable()
export class LocalStorage implements MediaStorage {
  readonly kind = "local" as const;
  private readonly log = new Logger("LocalStorage");

  async put(args: {
    workspaceId: string;
    buffer: Buffer;
    mimeType: string;
    originalFilename: string;
  }): Promise<{ key: string }> {
    const ext = path
      .extname(args.originalFilename)
      .toLowerCase()
      .slice(0, 8);
    const id = randomBytes(8).toString("hex");
    const dir = path.resolve(UPLOAD_ROOT, args.workspaceId);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.resolve(dir, `${id}${ext}`);
    await fs.writeFile(filePath, args.buffer);
    const key = `${args.workspaceId}/${id}${ext}`;
    return { key };
  }

  /** Local files have no real "signed URL" — the caller (controller) just
   *  streams them through an authenticated route. We return a sentinel so
   *  the service knows to stream rather than redirect. */
  async getSignedUrl(): Promise<string> {
    return "local://stream";
  }

  async delete(key: string): Promise<void> {
    const absolute = this.resolveAbsolute(key);
    if (!absolute) return;
    try {
      await fs.unlink(absolute);
    } catch (err) {
      this.log.warn(`Unlink failed for ${key}: ${(err as Error).message}`);
    }
  }

  /** Resolve a stored key to an absolute path, guarding against traversal.
   *  Returns null if the path would escape the workspace upload root. */
  resolveAbsolute(key: string): string | null {
    const [workspaceId] = key.split("/");
    if (!workspaceId) return null;
    const absolute = path.resolve(UPLOAD_ROOT, key);
    const wsRoot = path.resolve(UPLOAD_ROOT, workspaceId);
    if (!absolute.startsWith(wsRoot + path.sep)) return null;
    return absolute;
  }
}
