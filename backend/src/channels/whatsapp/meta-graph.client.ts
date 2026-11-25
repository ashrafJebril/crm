import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { redactUrl } from "../../common/redact-url";

/** Injection token for the `fetch` the client uses (specs pass a fake). */
export const META_GRAPH_FETCH = Symbol("META_GRAPH_FETCH");
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const DEFAULT_VERSION = "v21.0";
const TIMEOUT_MS = 15_000;

/** `META_GRAPH_VERSION` when it looks like `v<major>.<minor>`, else v21.0
 *  (the version the rest of the backend calls). */
export function graphVersion(env: Record<string, string | undefined> = process.env): string {
  const v = (env.META_GRAPH_VERSION ?? "").trim();
  return /^v\d{1,3}\.\d{1,3}$/.test(v) ? v : DEFAULT_VERSION;
}

export const DEFAULT_GRAPH_BASE = "https://graph.facebook.com";
let warnedBase = false;

/**
 * SP-14 ruling 13: the Graph base URL. `META_GRAPH_BASE_URL` is honoured only
 * when it is exactly `https://graph.facebook.com` or a loopback
 * `http://127.0.0.1:<port>` (the verification stub); anything else falls back
 * to the default with a one-time warning, so a mistyped env can never send a
 * token to another host. The rejected value is never logged.
 */
export function metaGraphBase(env: Record<string, string | undefined> = process.env): string {
  const raw = (env.META_GRAPH_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!raw) return DEFAULT_GRAPH_BASE;
  const loopback = /^http:\/\/127\.0\.0\.1:(\d{2,5})$/.exec(raw);
  if (raw === DEFAULT_GRAPH_BASE || (loopback && Number(loopback[1]) <= 65535)) return raw;
  if (!warnedBase) {
    warnedBase = true;
    new Logger("MetaGraphClient").warn("META_GRAPH_BASE_URL is not graph.facebook.com or 127.0.0.1; using the default");
  }
  return DEFAULT_GRAPH_BASE;
}

/** SP-14: per-call timeout for health reads. */
export const HEALTH_TIMEOUT_MS = 10_000;
/** SP-14: the template fields a health read asks for. */
export const TEMPLATE_HEALTH_FIELDS = "id,name,language,status,quality_score,category,rejected_reason";

/** One row of `/{waba}/message_templates` (the fields health reads). */
export interface MetaTemplateRow {
  id?: string;
  name?: string;
  language?: string;
  status?: string;
  category?: string;
  quality_score?: { score?: string };
  rejected_reason?: string;
}

/**
 * A failed Graph call. `message` is Graph's own error text with every secret
 * of the call scrubbed out; `code`/`subcode` are Graph's numeric error codes
 * (null for a network failure, `status` 0). The original error is never kept
 * as `cause` (its message or stack may hold the request URL).
 */
export class MetaGraphError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number | null = null,
    readonly subcode: number | null = null,
  ) {
    super(message);
    this.name = "MetaGraphError";
  }
}

export interface MetaPhoneNumber {
  id: string;
  display_phone_number?: string;
  verified_name?: string;
  platform_type?: string;
  code_verification_status?: string;
}

interface CallOptions {
  token?: string;
  query?: Record<string, string>;
  body?: unknown;
  /** Extra values to scrub from error text (app secret, code…). */
  secrets?: string[];
  /** Overrides the default 15 s timeout (health reads use 10 s). */
  timeoutMs?: number;
}

/**
 * Thin client for the Graph edges SP-19 T4 needs: the embedded-signup code
 * exchange, WABA subscription, number registration and the landline
 * add-number / request_code / verify_code steps.
 *
 * Tokens travel in the `Authorization` header. Only the code exchange and
 * debug_token put secrets in the query (Graph requires it); those URLs are
 * logged through `redactUrl`, and no request body is ever logged.
 */
@Injectable()
export class MetaGraphClient {
  private readonly log = new Logger(MetaGraphClient.name);

  constructor(@Optional() @Inject(META_GRAPH_FETCH) private readonly fetchImpl?: FetchLike) {}

  /** Embedded-signup `code` → business integration token. */
  async exchangeCode(appId: string, appSecret: string, code: string): Promise<string> {
    const res = await this.call<{ access_token?: string }>("GET", "/oauth/access_token", {
      query: { client_id: appId, client_secret: appSecret, code },
      secrets: [appSecret, code],
    });
    if (!res?.access_token) throw new MetaGraphError("Meta did not return an access token", 502);
    return res.access_token;
  }

  /** WABA ids a token was granted (`debug_token` granular scopes). */
  async grantedWabaIds(token: string, appId: string, appSecret: string): Promise<string[]> {
    const appToken = `${appId}|${appSecret}`;
    const res = await this.call<{ data?: { granular_scopes?: Array<{ scope: string; target_ids?: string[] }> } }>(
      "GET",
      "/debug_token",
      { query: { input_token: token, access_token: appToken }, secrets: [token, appSecret, appToken] },
    );
    const ids = new Set<string>();
    for (const s of res?.data?.granular_scopes ?? []) {
      if (s.scope === "whatsapp_business_management" || s.scope === "whatsapp_business_messaging") {
        for (const id of s.target_ids ?? []) ids.add(String(id));
      }
    }
    return [...ids];
  }

  async getPhoneNumber(phoneNumberId: string, token: string): Promise<MetaPhoneNumber> {
    return this.call<MetaPhoneNumber>("GET", `/${seg(phoneNumberId)}`, {
      token,
      query: { fields: "id,display_phone_number,verified_name,platform_type,code_verification_status" },
    });
  }

  async listPhoneNumbers(wabaId: string, token: string): Promise<MetaPhoneNumber[]> {
    const res = await this.call<{ data?: MetaPhoneNumber[] }>("GET", `/${seg(wabaId)}/phone_numbers`, {
      token,
      query: { fields: "id,display_phone_number,verified_name,platform_type,code_verification_status" },
    });
    return res?.data ?? [];
  }

  /** Subscribe our app to the WABA's webhooks (idempotent at Meta). */
  async subscribeApp(wabaId: string, token: string): Promise<void> {
    const res = await this.call<{ success?: boolean }>("POST", `/${seg(wabaId)}/subscribed_apps`, { token });
    if (res?.success !== true) throw new MetaGraphError("Subscribe returned success=false", 502);
  }

  /** Register the number on Cloud API with a two-step PIN. */
  async register(phoneNumberId: string, token: string, pin: string): Promise<void> {
    await this.call("POST", `/${seg(phoneNumberId)}/register`, {
      token,
      body: { messaging_product: "whatsapp", pin },
      secrets: [pin],
    });
  }

  async addPhoneNumber(
    wabaId: string,
    token: string,
    input: { cc: string; phoneNumber: string; verifiedName: string },
  ): Promise<{ id: string }> {
    const res = await this.call<{ id?: string }>("POST", `/${seg(wabaId)}/phone_numbers`, {
      token,
      body: { cc: input.cc, phone_number: input.phoneNumber, verified_name: input.verifiedName },
    });
    if (!res?.id) throw new MetaGraphError("Meta did not return a phone number id", 502);
    return { id: String(res.id) };
  }

  async requestCode(phoneNumberId: string, token: string, method: "SMS" | "VOICE", language: string): Promise<void> {
    await this.call("POST", `/${seg(phoneNumberId)}/request_code`, {
      token,
      body: { code_method: method, language },
    });
  }

  async verifyCode(phoneNumberId: string, token: string, code: string): Promise<void> {
    await this.call("POST", `/${seg(phoneNumberId)}/verify_code`, { token, body: { code }, secrets: [code] });
  }

  /**
   * SP-14: one field of a Graph node (`GET /{node}?fields=<field>`), so a
   * field one Graph version does not know fails alone. Returns the field's
   * raw value (undefined when Graph omits it).
   */
  async getField(nodeId: string, field: string, token: string): Promise<unknown> {
    if (!/^[a-z_]{1,64}$/.test(field)) throw new MetaGraphError("Invalid Graph field", 400);
    const res = await this.call<Record<string, unknown> | undefined>("GET", `/${seg(nodeId)}`, {
      token,
      query: { fields: field },
      timeoutMs: HEALTH_TIMEOUT_MS,
    });
    return res && typeof res === "object" ? res[field] : undefined;
  }

  /** SP-14: one page (100) of a WABA's templates; `after` is the next cursor, null on the last page. */
  async listTemplates(
    wabaId: string,
    token: string,
    opts: { after?: string } = {},
  ): Promise<{ data: MetaTemplateRow[]; after: string | null }> {
    const res = await this.call<{ data?: unknown; paging?: { next?: string; cursors?: { after?: string } } } | undefined>(
      "GET",
      `/${seg(wabaId)}/message_templates`,
      {
        token,
        query: { fields: TEMPLATE_HEALTH_FIELDS, limit: "100", ...(opts.after ? { after: opts.after } : {}) },
        timeoutMs: HEALTH_TIMEOUT_MS,
      },
    );
    const data = Array.isArray(res?.data) ? (res!.data as MetaTemplateRow[]) : [];
    const after = res?.paging?.next && res.paging.cursors?.after ? String(res.paging.cursors.after) : null;
    return { data, after };
  }

  private async call<T>(method: "GET" | "POST", path: string, opts: CallOptions = {}): Promise<T> {
    const url = new URL(`${metaGraphBase()}/${graphVersion()}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const href = url.toString();
    const secrets = [opts.token, ...(opts.secrets ?? [])].filter((s): s is string => !!s && s.length >= 4);
    const scrub = (text: string) => {
      let out = redactUrl(text);
      for (const s of secrets) out = out.split(s).join("***");
      return out;
    };
    const headers: Record<string, string> = {};
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";

    let res: Response;
    try {
      const doFetch: FetchLike = this.fetchImpl ?? ((u, i) => fetch(u, i));
      res = await doFetch(href, {
        method,
        headers,
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
      });
    } catch (e) {
      const timeout = (e as Error)?.name === "TimeoutError";
      this.log.warn(`Graph ${method} ${redactUrl(href)} failed: ${timeout ? "timeout" : "network error"}`);
      throw new MetaGraphError(timeout ? "Graph API timed out" : "Graph API unreachable", 0);
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!res.ok) {
      const err = (parsed as { error?: { message?: unknown; code?: unknown; error_subcode?: unknown } } | undefined)?.error;
      const code = typeof err?.code === "number" ? err.code : null;
      const subcode = typeof err?.error_subcode === "number" ? err.error_subcode : null;
      const message = scrub(typeof err?.message === "string" && err.message ? err.message : `Graph error ${res.status}`);
      this.log.warn(`Graph ${method} ${scrub(href)} -> ${res.status} code=${code ?? "-"}`);
      throw new MetaGraphError(message, res.status, code, subcode);
    }
    return parsed as T;
  }
}

/** A Graph id as a single path segment (ids are numeric; anything else is
 *  encoded so it can never walk to another edge). */
function seg(id: string): string {
  return encodeURIComponent(String(id));
}
