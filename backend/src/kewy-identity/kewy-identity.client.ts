import { Injectable, Logger } from "@nestjs/common";

/* ------------------------------------------------------------------------ *
 * Wire types — mirror kewy-website/src/lib/idp/{schemas,service}.ts.
 * ------------------------------------------------------------------------ */

export interface KewyTenantEntitlements {
  /** The crm Workspace.id. */
  externalTenantId: string;
  workspaceId: string | null;
  active: boolean;
  packageName: string | null;
  packageKind: string | null;
  /** Null when Kewy has no package state; [] would mean "unrestricted" here. */
  enabledModules: string[] | null;
  quotas?: Record<string, number>;
  trialEndsAt: string | null;
}

export interface KewyAuthResult {
  accountId: string;
  matched: "account" | "legacy";
  account: { email: string | null; phone: string | null; name: string; locale: string };
  /** externalUserId is the crm User.id. */
  identities: { externalUserId: string; externalTenantId: string | null }[];
  tenants: KewyTenantEntitlements[];
}

export interface KewyIdentityInput {
  externalUserId: string;
  externalTenantId?: string | null;
  email?: string | null;
  phone?: string | null;
  name?: string | null;
  locale?: string | null;
  password?: string | null;
  passwordHash?: string | null;
}

export interface KewyMirrorResult {
  externalUserId: string;
  accountId: string | null;
  action: "linked" | "created" | "updated";
  conflict: boolean;
}

export interface KewyImportResult {
  dryRun: boolean;
  summary: { created: number; linked: number; updated: number; conflicts: number; errors: number };
  results: (KewyMirrorResult | { externalUserId: string; error: string })[];
}

/**
 * Every call resolves to exactly one of:
 *  - `ok`: 2xx with a parsed body.
 *  - `rejected`: Kewy answered 4xx — a definite answer (INVALID_CREDENTIALS,
 *    ACCOUNT_DISABLED, RATE_LIMITED, IDENTITY_NOT_FOUND, …). Never retry or
 *    fall back on these.
 *  - `unreachable`: no usable answer — not configured, network error,
 *    timeout, 5xx, or an unparseable 2xx body.
 */
export type KewyResult<T> =
  | { kind: "ok"; status: number; data: T }
  | {
      kind: "rejected";
      status: number;
      code: string;
      message?: string;
      retryAfterSec?: number;
    }
  | { kind: "unreachable"; reason: string; status?: number };

export const KEWY_IDP_SECRET_HEADER = "x-kewy-idp-secret";
export const KEWY_IDP_TIMEOUT_MS = 5_000;

/**
 * Machine-to-machine client for Kewy's identity API (`/api/idp/v1`).
 * Reads KEWY_IDP_URL (e.g. https://kewy.ai/api/idp/v1) and KEWY_IDP_SECRET
 * per call so it also works outside Nest (scripts: `new KewyIdentityClient()`).
 * Never throws: every outcome is a KewyResult.
 */
@Injectable()
export class KewyIdentityClient {
  private readonly logger = new Logger(KewyIdentityClient.name);

  get configured(): boolean {
    return Boolean(process.env.KEWY_IDP_URL && process.env.KEWY_IDP_SECRET);
  }

  authenticate(body: {
    identifier: string;
    password: string;
    clientIp?: string;
  }): Promise<KewyResult<KewyAuthResult>> {
    return this.call("POST", "/authenticate", body);
  }

  /** Mirror a crm user. Kewy never replaces an existing Account password. */
  mirrorIdentity(input: KewyIdentityInput): Promise<KewyResult<KewyMirrorResult>> {
    return this.call("POST", "/identities", input);
  }

  /** Make this password the Account's password for every product. */
  setPassword(
    externalUserId: string,
    body: ({ password: string } | { passwordHash: string }) & {
      /** "account": the user's own change, for every product. "product": set by someone else, crm only. */
      scope?: "account" | "product";
    },
  ): Promise<KewyResult<{ accountId: string; scope: "account" | "product" }>> {
    return this.call(
      "POST",
      `/identities/${encodeURIComponent(externalUserId)}/password`,
      body,
    );
  }

  deleteIdentity(externalUserId: string): Promise<KewyResult<{ removed: boolean }>> {
    return this.call("DELETE", `/identities/${encodeURIComponent(externalUserId)}`);
  }

  importIdentities(body: {
    dryRun: boolean;
    identities: KewyIdentityInput[];
  }): Promise<KewyResult<KewyImportResult>> {
    return this.call("POST", "/import", body);
  }

  private async call<T>(
    method: "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<KewyResult<T>> {
    const baseUrl = process.env.KEWY_IDP_URL;
    const secret = process.env.KEWY_IDP_SECRET;
    if (!baseUrl || !secret) return { kind: "unreachable", reason: "not configured" };

    const url = `${baseUrl.replace(/\/+$/, "")}${path}`;
    const headers: Record<string, string> = { [KEWY_IDP_SECRET_HEADER]: secret };
    if (body !== undefined) headers["content-type"] = "application/json";

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(KEWY_IDP_TIMEOUT_MS),
      });
    } catch (err) {
      const e = err as { name?: string; message?: string };
      const reason =
        e?.name === "TimeoutError" || e?.name === "AbortError"
          ? `timeout after ${KEWY_IDP_TIMEOUT_MS}ms`
          : `network error: ${e?.message ?? String(err)}`;
      return { kind: "unreachable", reason };
    }

    const parsed = await res.json().catch(() => undefined);

    if (res.status >= 500) {
      return { kind: "unreachable", reason: `HTTP ${res.status}`, status: res.status };
    }
    if (res.status >= 400) {
      const b = (parsed ?? {}) as { error?: unknown; message?: unknown; retryAfterSec?: unknown };
      const headerRetry = Number(res.headers.get("retry-after"));
      const retryAfterSec =
        typeof b.retryAfterSec === "number"
          ? b.retryAfterSec
          : Number.isFinite(headerRetry) && headerRetry > 0
            ? headerRetry
            : undefined;
      return {
        kind: "rejected",
        status: res.status,
        code: typeof b.error === "string" ? b.error : `HTTP_${res.status}`,
        ...(typeof b.message === "string" ? { message: b.message } : {}),
        ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
      };
    }
    if (res.status < 200 || res.status >= 300 || parsed === undefined) {
      this.logger.warn(`Unexpected Kewy IdP response for ${method} ${path}: HTTP ${res.status}`);
      return { kind: "unreachable", reason: `unexpected response (HTTP ${res.status})`, status: res.status };
    }
    return { kind: "ok", status: res.status, data: parsed as T };
  }
}
