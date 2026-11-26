import {
  BadGatewayException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";

interface JoteckRequestOpts {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  formData?: FormData;
  /** SP-20: abort the call after this many ms (a 502 like any unreachable call). */
  timeoutMs?: number;
  /**
   * Pass l's own error body through when its `message` starts with this
   * prefix (e.g. "knowledge."): those are user-facing keys the screens
   * translate, not provider detail.
   */
  passErrors?: string;
}

/**
 * Low-level client for the l agent platform's service-to-service "joteck"
 * admin surface (`/api/v1/joteck/...`). Every Knowledge/Tools/MCP proxy
 * service in this module goes through this — the shared secret and error
 * mapping live in exactly one place.
 *
 * L_JOTECK_SECRET is a different secret from this CRM's own JOTECK_CRM_SECRET
 * (backend/src/joteck/joteck.guard.ts): that one gates the Kewy console
 * calling INTO this CRM; this one is this CRM calling OUT to l.
 */
@Injectable()
export class LJoteckClient {
  private readonly logger = new Logger(LJoteckClient.name);

  get enabled(): boolean {
    return Boolean(process.env.L_API_URL && process.env.L_JOTECK_SECRET);
  }

  async request<T>(path: string, opts: JoteckRequestOpts = {}): Promise<T> {
    const res = await this.send(path, opts);
    if (res.status === 204) return undefined as T;
    const raw = await res.text();
    return (raw ? safeJson(raw) : undefined) as T;
  }

  /** Like `request`, for a binary body (a stored file). */
  async requestRaw(path: string, opts: JoteckRequestOpts = {}): Promise<{ data: Buffer; contentType: string | null; disposition: string | null }> {
    const res = await this.send(path, opts);
    return {
      data: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get("content-type"),
      disposition: res.headers.get("content-disposition"),
    };
  }

  /** The call. An error status throws, so what returns is ok. */
  private async send(path: string, opts: JoteckRequestOpts): Promise<Response> {
    const baseUrl = process.env.L_API_URL;
    const secret = process.env.L_JOTECK_SECRET;
    if (!baseUrl || !secret) {
      throw new ServiceUnavailableException("Kewy AI platform is not configured");
    }

    const url = `${baseUrl.replace(/\/$/, "")}/api/v1/joteck${path}`;
    const headers: Record<string, string> = { "x-joteck-secret": secret };
    let body: BodyInit | undefined;
    if (opts.formData) {
      body = opts.formData;
    } else if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.body);
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: opts.method ?? "GET",
        headers,
        body,
        ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
      });
    } catch (err) {
      this.logger.warn(
        `Could not reach l platform at ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new BadGatewayException("Could not reach the Kewy AI platform");
    }

    if (res.ok) return res;
    const raw = await res.text();
    const data: unknown = raw ? safeJson(raw) : undefined;
    {
      const detail = isRecord(data) && typeof data.detail === "string" ? data.detail : undefined;
      this.logger.warn(
        `l platform returned ${res.status} for ${url}${detail ? `: ${detail}` : ""}`,
      );

      // A 401/403 here means the l platform rejected THIS CRM's own
      // service-to-service secret (misconfigured/rotated L_JOTECK_SECRET) —
      // it has nothing to do with the end user's CRM session. Passing it
      // through verbatim would trip the frontend's global "401 with a token
      // attached = session expired" logout hook (src/api/client.ts), logging
      // out a user over a platform misconfiguration. Remap to 502 instead.
      const status = res.status === 401 || res.status === 403 ? 502 : res.status;
      if (opts.passErrors && status === res.status && isRecord(data) && typeof data.message === "string" && data.message.startsWith(opts.passErrors)) {
        throw new HttpException(data, status);
      }

      // Per spec: don't leak upstream error detail to the browser — log it
      // server-side (above) and surface a generic message instead.
      throw new HttpException("Kewy AI platform returned an error", status);
    }
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
