/**
 * SP-21 knowledge upload parsing: multer (memory storage) with the knowledge
 * limits, and its errors mapped to knowledge keys instead of Nest's generic
 * "File too large" / "Unexpected field":
 *  - LIMIT_FILE_SIZE → 413 `knowledge.file_too_large {maxBytes}`;
 *  - LIMIT_FILE_COUNT / LIMIT_UNEXPECTED_FILE → 400 `knowledge.batch_too_large {max}`;
 *  - any other multipart problem → 400 `knowledge.file_type`.
 * File names are decoded to UTF-8: multer (busboy) hands them over as
 * latin1, which garbles Arabic names. (The media upload has the same issue;
 * it is left alone here and noted as a follow-up.)
 */
import { CallHandler, ExecutionContext, HttpException, Injectable, NestInterceptor } from "@nestjs/common";
import multer, { MulterError, memoryStorage } from "multer";
import type { Observable } from "rxjs";
import { KB_BATCH_MAX, KB_FILE_MAX_BYTES } from "./knowledge-constants";
import { knowledgeError } from "./knowledge-errors";

/** The multipart field holding the files (repeat it once per file). */
export const UPLOAD_FIELD = "files";

/** latin1-decoded UTF-8 → the real name; a name that is not such a mis-decoding is kept. */
export function decodeFileName(name: string): string {
  if (!name || /[^\u0000-ÿ]/.test(name)) return name;
  const utf8 = Buffer.from(name, "latin1").toString("utf8");
  return utf8.includes("�") ? name : utf8;
}

export function mapUploadError(err: unknown): HttpException {
  if (err instanceof HttpException) return err;
  if (err instanceof MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return new HttpException({ statusCode: 413, message: "knowledge.file_too_large", maxBytes: KB_FILE_MAX_BYTES }, 413);
    }
    if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
      return knowledgeError("knowledge.batch_too_large", { max: KB_BATCH_MAX });
    }
  }
  return knowledgeError("knowledge.file_type", { fileName: null });
}

@Injectable()
export class KnowledgeUploadInterceptor implements NestInterceptor {
  private readonly upload = multer({
    // In memory: every file of the batch is checked before anything is stored.
    storage: memoryStorage(),
    limits: { fileSize: KB_FILE_MAX_BYTES, files: KB_BATCH_MAX },
  }).array(UPLOAD_FIELD, KB_BATCH_MAX);

  async intercept(ctx: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const http = ctx.switchToHttp();
    const req = http.getRequest<{ files?: Express.Multer.File[] }>();
    await new Promise<void>((resolve, reject) => {
      this.upload(req as never, http.getResponse(), (err?: unknown) => (err ? reject(mapUploadError(err)) : resolve()));
    });
    for (const f of req.files ?? []) f.originalname = decodeFileName(f.originalname);
    return next.handle();
  }
}
