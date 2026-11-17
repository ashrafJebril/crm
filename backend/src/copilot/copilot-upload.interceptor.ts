/**
 * SP-18 copilot attachment upload: multer in memory, one file in the field
 * `file`, at most ATTACH_DOC_MAX_BYTES (the per-type limit is checked in the
 * service). Multer's errors become copilot keys; file names are decoded to
 * UTF-8 (the SP-21 helper).
 */
import { CallHandler, ExecutionContext, HttpException, Injectable, NestInterceptor } from "@nestjs/common";
import multer, { MulterError, memoryStorage } from "multer";
import type { Observable } from "rxjs";
import { decodeFileName } from "../knowledge-sources/knowledge-upload.interceptor";
import { ATTACH_DOC_MAX_BYTES } from "./copilot-constants";
import { copilotError } from "./copilot-errors";

export const ATTACH_FIELD = "file";

export function mapAttachError(err: unknown): HttpException {
  if (err instanceof HttpException) return err;
  if (err instanceof MulterError && err.code === "LIMIT_FILE_SIZE") return copilotError("copilot.attachment_too_large", { maxBytes: ATTACH_DOC_MAX_BYTES });
  if (err instanceof MulterError && (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE")) {
    return copilotError("copilot.too_many_attachments", { max: 1 });
  }
  return copilotError("copilot.attachment_type");
}

@Injectable()
export class CopilotUploadInterceptor implements NestInterceptor {
  private readonly upload = multer({ storage: memoryStorage(), limits: { fileSize: ATTACH_DOC_MAX_BYTES, files: 1 } }).single(ATTACH_FIELD);

  async intercept(ctx: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const http = ctx.switchToHttp();
    const req = http.getRequest<{ file?: Express.Multer.File }>();
    await new Promise<void>((resolve, reject) => {
      this.upload(req as never, http.getResponse(), (err?: unknown) => (err ? reject(mapAttachError(err)) : resolve()));
    });
    if (req.file) req.file.originalname = decodeFileName(req.file.originalname);
    return next.handle();
  }
}
