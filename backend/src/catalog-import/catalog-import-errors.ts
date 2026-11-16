import { HttpException } from "@nestjs/common";

/**
 * SP-10 catalog import error keys (Global Constraints → Error keys). The
 * `message` is the key (the frontend maps it through `tx` in
 * `src/screens/calendar/bookingErrors.ts`); extras ride along. The same keys
 * are stored as `CatalogImport.errorKey` when a background step fails.
 */
export const CATALOG_IMPORT_ERROR_STATUS = {
  "catalog_import.text_too_long": 400, // {max}
  "catalog_import.url_invalid": 400,
  "catalog_import.url_blocked": 400,
  "catalog_import.url_fetch_failed": 502,
  "catalog_import.file_invalid": 400,
  "catalog_import.too_many_rows": 400, // {max}
  "catalog_import.ai_unavailable": 503,
  "catalog_import.ai_failed": 502,
  "catalog_import.nothing_found": 422,
  "catalog_import.not_in_review": 409, // {status}
  "catalog_import.item_invalid": 400, // {key, field}
  // Additions (Task 3): an unknown/foreign job, a bad source/kind, a finished job.
  "catalog_import.not_found": 404,
  "catalog_import.source_invalid": 400,
  "catalog_import.already_finished": 409, // {status}
  // Review M3: a run that kept stalling, failed by the resume sweep (stored errorKey only).
  "catalog_import.run_stalled": 500,
} as const;

export type CatalogImportErrorKey = keyof typeof CATALOG_IMPORT_ERROR_STATUS;
export const CATALOG_IMPORT_ERROR_KEYS = Object.keys(CATALOG_IMPORT_ERROR_STATUS) as CatalogImportErrorKey[];

/** A typed failure of a background step (fetch, extraction); its key becomes `errorKey`. */
export class CatalogImportFailure extends Error {
  constructor(public readonly key: CatalogImportErrorKey) {
    super(key);
    this.name = "CatalogImportFailure";
  }
}

export function catalogImportError(key: CatalogImportErrorKey, extra: Record<string, unknown> = {}): HttpException {
  const statusCode = CATALOG_IMPORT_ERROR_STATUS[key];
  return new HttpException({ statusCode, message: key, ...extra }, statusCode);
}

/** The error key of anything a background step threw (unknown → the step's default). */
export function failureKey(e: unknown, fallback: CatalogImportErrorKey): CatalogImportErrorKey {
  return e instanceof CatalogImportFailure ? e.key : fallback;
}
