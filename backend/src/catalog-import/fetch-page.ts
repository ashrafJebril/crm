/**
 * SP-10 catalog import: fetch ONE public web page as text (ruling 9). The
 * SSRF guard (https only, public addresses on every hop, DNS pinning, ≤ 3
 * redirects, test base) lives in `common/public-fetch.ts` since SP-21, which
 * the knowledge crawler shares; this file keeps the catalog import's API and
 * error keys: `text/html` or `text/plain` only, ≤ 2 MB streamed, 10 s total.
 */
import { CatalogImportFailure } from "./catalog-import-errors";
import { htmlToText, plainText } from "./html-to-text";
import {
  defaultDeps,
  fetchPublic,
  parsePublicUrl as parsePublic,
  PublicFetchError,
  type PageFetchDeps,
} from "../common/public-fetch";

export {
  FETCH_TIMEOUT_MS,
  MAX_PAGE_BYTES,
  MAX_REDIRECTS,
  defaultDeps,
  isPublicAddress,
  redactedUrl,
  type PageFetchDeps,
  type PageRequest,
  type PageResponse,
  type ResolvedAddress,
} from "../common/public-fetch";

function toCatalog(e: unknown): CatalogImportFailure {
  if (e instanceof CatalogImportFailure) return e;
  if (e instanceof PublicFetchError) {
    if (e.code === "url_invalid") return new CatalogImportFailure("catalog_import.url_invalid");
    if (e.code === "url_blocked") return new CatalogImportFailure("catalog_import.url_blocked");
  }
  return new CatalogImportFailure("catalog_import.url_fetch_failed");
}

/** An https URL on the default port without credentials; else catalog_import.url_invalid. */
export function parsePublicUrl(raw: string, base?: URL): URL {
  try {
    return parsePublic(raw, base);
  } catch (e) {
    throw toCatalog(e);
  }
}

/** Returns the page as plain text (≤ maxChars). Throws CatalogImportFailure. */
export async function fetchPageText(rawUrl: string, maxChars: number, deps: PageFetchDeps = defaultDeps()): Promise<string> {
  try {
    const res = await fetchPublic(rawUrl, { accept: ["text/html", "text/plain"] }, deps);
    return res.contentType === "text/html" ? htmlToText(res.body, maxChars) : plainText(res.body, maxChars);
  } catch (e) {
    throw toCatalog(e);
  }
}
