/**
 * SP-10 catalog import: AI extraction through the Anthropic Messages API
 * (ruling 10), the way `ads/ads-chat.service.ts` calls it: raw `fetch`
 * (no new dependency, per the plan's "No new dependencies"), `x-api-key`
 * from ANTHROPIC_API_KEY, `ANTHROPIC_API_URL` override.
 *
 * Request (checked against the claude-api reference):
 *  - model: CATALOG_IMPORT_MODEL, default `claude-opus-5-5`. The ads chat's
 *    default (`claude-sonnet-5`) is a previous generation, so the current
 *    recommended model is used (controller ruling R10).
 *  - Structured output (`output_config.format` json_schema), not a forced
 *    tool: forced `tool_choice` returns a 400 on this model. Thinking stays
 *    adaptive (it cannot be disabled on this model); `effort: "low"` because
 *    extraction is simple and latency matters.
 *  - Server-side refusal fallback (`fallbacks: "default"`, beta
 *    `server-side-fallback-2026-07-01`), the recommended default.
 *  - `anthropic-version: 2026-10-21` (no sampling parameters are sent).
 *  - One request, no retry, 180 s timeout (CATALOG_IMPORT_TIMEOUT_MS, kept
 *    within 10..270 s so the 5-minute stale-extraction sweep still covers
 *    it; review M2). A refusal, a cut-off reply, a
 *    non-JSON reply or one failing the `zod` schema → `catalog_import.ai_failed`.
 *
 * `ANTHROPIC_API_URL` must be the Anthropic URL or, for verification only,
 * `http://127.0.0.1:<port>/…`; anything else (or no key) → `ai_unavailable`.
 * The input text and the model output are never logged.
 */
import { Injectable, Logger } from "@nestjs/common";
import { CatalogImportFailure } from "./catalog-import-errors";
import { EXTRACTION_JSON_SCHEMA, extractionSchema, type Extraction, type ImportKind } from "./extraction-schema";
import { EXTRACTION_SYSTEM_PROMPT, extractionUserPrompt } from "./extraction-prompt";

export const CATALOG_EXTRACTOR = Symbol("CATALOG_EXTRACTOR");

export interface CatalogExtractor {
  /** True when a key and an allowed endpoint are configured. */
  available(): boolean;
  /** Throws CatalogImportFailure (`ai_unavailable` / `ai_failed`). */
  extract(text: string, kind: ImportKind): Promise<Extraction>;
}

export const DEFAULT_API_URL = "https://api.anthropic.com/v1/messages";
export const DEFAULT_CATALOG_IMPORT_MODEL = "claude-opus-5-5";
const API_VERSION = "2026-10-21";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const MAX_TOKENS = 16_000;
/** Default call timeout: a large catalog's structured reply plus adaptive thinking can take minutes (review M2). */
export const EXTRACTION_TIMEOUT_MS = 180_000;
const MIN_TIMEOUT_MS = 10_000;
/** Below the scheduler's 5-minute STALE_EXTRACTION_MS, so a live call is never failed as stale. */
const MAX_TIMEOUT_MS = 270_000;

/** CATALOG_IMPORT_TIMEOUT_MS (ms), clamped to 10..270 s; unset or invalid → 180 s. */
export function extractionTimeoutMs(): number {
  const n = Number(process.env.CATALOG_IMPORT_TIMEOUT_MS?.trim());
  if (!Number.isFinite(n) || n <= 0) return EXTRACTION_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(n)));
}
const LOOPBACK_RE = /^http:\/\/127\.0\.0\.1:\d{2,5}\//;

export function allowedApiUrl(url: string): boolean {
  return url === DEFAULT_API_URL || LOOPBACK_RE.test(url);
}

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

@Injectable()
export class AnthropicCatalogExtractor implements CatalogExtractor {
  private readonly log = new Logger(AnthropicCatalogExtractor.name);

  /** The HTTP call; specs replace it (an unmocked call in a spec would be a live call). */
  private fetchFn: FetchFn = (url, init) => fetch(url, init);

  /** An extractor with an injected `fetch` (specs, verification stubs). */
  static withFetch(fn: FetchFn): AnthropicCatalogExtractor {
    const x = new AnthropicCatalogExtractor();
    x.fetchFn = fn;
    return x;
  }

  private config() {
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    const apiUrl = process.env.ANTHROPIC_API_URL?.trim() || DEFAULT_API_URL;
    const model = process.env.CATALOG_IMPORT_MODEL?.trim() || DEFAULT_CATALOG_IMPORT_MODEL;
    return { apiKey, apiUrl, model };
  }

  available(): boolean {
    const { apiKey, apiUrl } = this.config();
    return !!apiKey && allowedApiUrl(apiUrl);
  }

  async extract(text: string, kind: ImportKind): Promise<Extraction> {
    const { apiKey, apiUrl, model } = this.config();
    if (!apiKey || !allowedApiUrl(apiUrl)) throw new CatalogImportFailure("catalog_import.ai_unavailable");
    const body = JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      system: EXTRACTION_SYSTEM_PROMPT,
      messages: [{ role: "user", content: extractionUserPrompt(text, kind) }],
      output_config: { effort: "low", format: { type: "json_schema", schema: EXTRACTION_JSON_SCHEMA } },
      fallbacks: "default",
    });
    let status = 0;
    let raw = "";
    try {
      const res = await this.fetchFn(apiUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": API_VERSION,
          "anthropic-beta": FALLBACK_BETA,
        },
        body,
        signal: AbortSignal.timeout(extractionTimeoutMs()),
      });
      status = res.status;
      raw = await res.text();
      if (!res.ok) {
        // Status only: the error body may echo the request.
        this.log.warn(`catalog extraction refused: HTTP ${status}`);
        throw new CatalogImportFailure(status === 401 || status === 403 ? "catalog_import.ai_unavailable" : "catalog_import.ai_failed");
      }
    } catch (e) {
      if (e instanceof CatalogImportFailure) throw e;
      this.log.warn(`catalog extraction call failed: ${(e as Error)?.name ?? "error"}`);
      throw new CatalogImportFailure("catalog_import.ai_failed");
    }
    return parseReply(raw);
  }
}

/** The Messages API response → a validated Extraction. Never logs content. */
export function parseReply(raw: string): Extraction {
  let msg: { stop_reason?: string; content?: { type: string; text?: string }[] };
  try {
    msg = JSON.parse(raw);
  } catch {
    throw new CatalogImportFailure("catalog_import.ai_failed");
  }
  // A refusal (of the whole fallback chain) or a cut-off reply is not trusted.
  if (msg?.stop_reason !== "end_turn") throw new CatalogImportFailure("catalog_import.ai_failed");
  const text = (msg.content ?? []).filter((b) => b?.type === "text").map((b) => b.text ?? "").join("");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CatalogImportFailure("catalog_import.ai_failed");
  }
  const parsed = extractionSchema.safeParse(json);
  if (!parsed.success) throw new CatalogImportFailure("catalog_import.ai_failed");
  return parsed.data;
}
