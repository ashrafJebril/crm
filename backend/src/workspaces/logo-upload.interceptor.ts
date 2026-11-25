/**
 * SP-29 logo upload: multer in memory (≤ 2 MB, one file in the field `file`).
 * Multer's own errors become the SP-13 media keys, so a file over the cap
 * gets `media.too_large {limit}` like the service's own check.
 */
import { CallHandler, ExecutionContext, HttpException, Injectable, NestInterceptor } from "@nestjs/common";
import multer, { MulterError, memoryStorage } from "multer";
import type { Observable } from "rxjs";
import { mediaError } from "../media/media-errors";
import { LOGO_MAX_BYTES } from "./brand-constants";

export const LOGO_FIELD = "file";

export function mapLogoUploadError(err: unknown): HttpException {
  if (err instanceof HttpException) return err;
  if (err instanceof MulterError && err.code === "LIMIT_FILE_SIZE") return mediaError("media.too_large", { limit: LOGO_MAX_BYTES });
  return mediaError("media.no_file");
}

@Injectable()
export class LogoUploadInterceptor implements NestInterceptor {
  private readonly upload = multer({ storage: memoryStorage(), limits: { fileSize: LOGO_MAX_BYTES, files: 1 } }).single(LOGO_FIELD);

  async intercept(ctx: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const http = ctx.switchToHttp();
    const req = http.getRequest();
    await new Promise<void>((resolve, reject) => {
      this.upload(req as never, http.getResponse(), (err?: unknown) => (err ? reject(mapLogoUploadError(err)) : resolve()));
    });
    return next.handle();
  }
}
