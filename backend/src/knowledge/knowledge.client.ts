import { HttpException, Injectable, Logger } from "@nestjs/common";

/**
 * Typed HTTP client for the kewy-ai knowledge admin API
 * (`<KEWY_AI_URL>/api/v1/knowledge/*`, header `x-kewy-admin-secret`).
 *
 * WHY THIS EXISTS AT ALL, RATHER THAN THE BROWSER CALLING kewy-ai DIRECTLY
 * -----------------------------------------------------------------------
 * `x-kewy-admin-secret` is ONE per-deployment key that can read and write
 * EVERY tenant's knowledge — kewy-ai's own admin.controller.ts says so: the
 * secret identifies kewy-site, not a salon, and the tenant is whatever the
 * caller names in the body. Shipping that to a React bundle would put a
 * cross-tenant write key in devtools and let any logged-in salon owner read a
 * competitor's pricing by editing one string. So the secret lives here, and
 * `tenantId` is stamped in by the caller from the session — never accepted
 * from a request body.
 *
 * WHY IT FAILS LOUD, UNLIKE ai-bridge.service.ts
 * ----------------------------------------------
 * AiBridgeService swallows everything because it sits on the WhatsApp webhook
 * path, where a thrown error means Meta redelivers and the customer gets the
 * message twice. Nothing here is on that path: a human pressed a button and is
 * watching. A save that silently did nothing is how an owner comes to believe
 * the AI knows their cancellation policy when it does not. So every failure
 * surfaces — but as a structured, already-classified HttpException the UI can
 * render, never a leaked upstream stack.
 */
@Injectable()
export class KnowledgeClient {
  private readonly log = new Logger(KnowledgeClient.name);

  /**
   * Generous compared with the bridge's 4s: `POST /docs` embeds the document
   * inline (kewy-ai's admin.service.ts runs ingest in the same call, on
   * purpose) and `POST /sync` re-pulls every service, branch and staff member
   * from hjz and embeds those too. Both are legitimately slow, and a timeout
   * mid-embed leaves the owner unsure whether the save landed.
   */
  private static readonly TIMEOUT_MS = 30_000;

  private config(): { baseUrl: string; secret: string } | null {
    const url = process.env.KEWY_AI_URL;
    // NOT KEWY_AI_WEBHOOK_SECRET — that one is the HMAC key for the inbound
    // message bridge and kewy-ai will 403 this API if you send it.
    const secret = process.env.KEWY_AI_ADMIN_SECRET;
    if (!url || !secret) return null;
    return { baseUrl: `${url.replace(/\/+$/, "")}/api/v1`, secret };
  }

  /** Lets the controller answer "not set up here" instead of a bare failure. */
  isConfigured(): boolean {
    return this.config() !== null;
  }

  async listDocs(tenantId: string): Promise<{ docs: KewyKnowledgeDoc[] }> {
    return this.request<{ docs: KewyKnowledgeDoc[] }>("GET", "/knowledge/docs", {
      query: { tenantId },
    });
  }

  /** `id` absent creates, `id` present updates — kewy-ai's upsert contract. */
  async upsertDoc(input: {
    tenantId: string;
    id?: string;
    title: string;
    body: string;
    kind: KewyKnowledgeKind;
  }): Promise<KewySaveDocResult> {
    return this.request<KewySaveDocResult>("POST", "/knowledge/docs", { body: input });
  }

  async deleteDoc(tenantId: string, id: string): Promise<{ ok: true; id: string }> {
    return this.request<{ ok: true; id: string }>(
      "DELETE",
      `/knowledge/docs/${encodeURIComponent(id)}`,
      { query: { tenantId } },
    );
  }

  async sync(tenantId: string): Promise<KewySyncResult> {
    return this.request<KewySyncResult>("POST", "/knowledge/sync", {
      body: { tenantId },
    });
  }

  /**
   * The owner's on/off switch for the product sync. Disabling DELETES the
   * synced docs upstream (owner's chosen semantics: off = the AI stops using
   * hjz data entirely). Enabling does not auto-sync; the UI re-syncs
   * explicitly so the owner watches the pull happen.
   */
  async setSyncEnabled(tenantId: string, enabled: boolean): Promise<KewySyncEnabledResult> {
    return this.request<KewySyncEnabledResult>("POST", "/knowledge/sync-enabled", {
      body: { tenantId, enabled },
    });
  }

  /* ─── Tenant AI settings ───────────────────────────────────────────────
   *
   * Same secret, same base URL, same failure classification — so these live
   * here rather than in a second client that would have to re-derive both.
   * Note the tenant moves into the PATH for these routes, not the body.
   */

  async getConfig(tenantId: string): Promise<KewyTenantConfig> {
    return this.request<KewyTenantConfig>("GET", `/admin/tenants/${encodeURIComponent(tenantId)}/config`);
  }

  /**
   * Partial update. Upstream rejects an empty patch with a 400, and identity
   * fields are not writable — callers must send only what they mean to change.
   */
  async patchConfig(
    tenantId: string,
    patch: Partial<Pick<KewyTenantConfig, "autonomyMode">>,
  ): Promise<KewyTenantConfig> {
    return this.request<KewyTenantConfig>(
      "PATCH",
      `/admin/tenants/${encodeURIComponent(tenantId)}/config`,
      { body: patch },
    );
  }

  /**
   * The emergency stop. `reason` is REQUIRED upstream when disabling (1..500
   * chars) — a silent kill switch is one nobody dares reverse. Callers should
   * enforce that before calling so the owner gets our wording, not a raw 400.
   */
  async setKillSwitch(
    tenantId: string,
    input: { aiEnabled: boolean; reason?: string },
  ): Promise<KewyKillSwitchResult> {
    return this.request<KewyKillSwitchResult>(
      "POST",
      `/admin/tenants/${encodeURIComponent(tenantId)}/kill-switch`,
      { body: input },
    );
  }

  private async request<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    opts: { query?: Record<string, string>; body?: unknown } = {},
  ): Promise<T> {
    const cfg = this.config();
    if (!cfg) {
      throw new HttpException(
        {
          code: "AI_NOT_CONFIGURED",
          message:
            "The AI service is not configured for this deployment — set KEWY_AI_URL and KEWY_AI_ADMIN_SECRET.",
        },
        503,
      );
    }

    const url = new URL(`${cfg.baseUrl}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method,
        headers: {
          "content-type": "application/json",
          "x-kewy-admin-secret": cfg.secret,
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(KnowledgeClient.TIMEOUT_MS),
      });
    } catch (e) {
      const timedOut = (e as Error).name === "TimeoutError";
      // The CRM must stay up when the AI service is down. Deliberately a 503,
      // not a 500: this is a dependency being unavailable, not us crashing, and
      // the difference is what stops it paging as a CRM outage.
      this.log.warn(`kewy-ai ${method} ${path} unreachable: ${(e as Error).message}`);
      throw new HttpException(
        {
          code: timedOut ? "AI_TIMEOUT" : "AI_UNAVAILABLE",
          message: timedOut
            ? "The AI service took too long to respond. Your change may not have been saved — reload to check."
            : "AI service unavailable. The rest of the CRM is unaffected; try again shortly.",
        },
        503,
      );
    }

    if (res.status === 204) return undefined as T;

    const raw = await res.text();
    const data: unknown = raw ? safeJson(raw) : undefined;

    if (!res.ok) {
      // NOTE the asymmetry: 4xx carries upstream's message through (it is a
      // validation complaint the owner can act on — "title too long"), while
      // 5xx is replaced wholesale. An upstream 500 body can contain stack
      // frames, connection strings, or the tenant ids of other salons.
      const upstreamMsg =
        typeof data === "object" && data !== null && "message" in data
          ? String((data as { message: unknown }).message)
          : "";
      this.log.warn(`kewy-ai ${method} ${path} -> ${res.status} ${upstreamMsg.slice(0, 200)}`);

      if (res.status === 404) {
        throw new HttpException(
          { code: "NOT_FOUND", message: upstreamMsg || "The AI service has no record of that." },
          404,
        );
      }
      if (res.status === 403 || res.status === 401) {
        // Never echo which secret or why — the owner cannot fix this anyway.
        throw new HttpException(
          {
            code: "AI_AUTH_FAILED",
            message: "The CRM could not authenticate with the AI service. Contact Kewy support.",
          },
          502,
        );
      }
      if (res.status >= 400 && res.status < 500) {
        throw new HttpException(
          { code: "AI_REJECTED", message: upstreamMsg || "The AI service rejected that request." },
          400,
        );
      }
      throw new HttpException(
        { code: "AI_ERROR", message: "The AI service failed to handle that request. Try again shortly." },
        502,
      );
    }

    return data as T;
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/** Mirrors kewy-ai's `KnowledgeDocKind`. Duplicated rather than imported —
 *  the two services deploy independently and share no package. */
export const KEWY_KNOWLEDGE_KINDS = [
  "POLICY",
  "FAQ",
  "SERVICE_DESCRIPTION",
  "PROMOTION",
  "TONE",
  "OTHER",
] as const;
export type KewyKnowledgeKind = (typeof KEWY_KNOWLEDGE_KINDS)[number];

/** kewy-ai's `OwnerDocView`. */
export interface KewyKnowledgeDoc {
  id: string;
  tenantId: string;
  kind: KewyKnowledgeKind;
  title: string;
  body: string;
  /** Non-null = pulled from hjz by the product sync. */
  sourceRef: string | null;
  syncedAt: string | null;
  updatedAt: string;
  /** False for synced docs: editing one is silently reverted by the next sync,
   *  so the UI must render it read-only rather than offer a broken button. */
  editable: boolean;
}

export interface KewySaveDocResult extends KewyKnowledgeDoc {
  chunksWritten: number;
}

export interface KewySyncResult {
  synced?: unknown[];
  [k: string]: unknown;
}

/** kewy-ai's answer to POST /knowledge/sync-enabled. */
export interface KewySyncEnabledResult {
  tenantId: string;
  productSyncEnabled: boolean;
  previousProductSyncEnabled: boolean;
  /** False when the flag was already in the requested state. */
  changed: boolean;
  /** How many synced docs were removed (0 on enable). */
  deletedDocs: number;
}

/** Whether the reply is SENT, not whether the agent runs. SHADOW still calls
 *  the model and still costs money; it writes the draft into the thread marked
 *  as not sent. AUTONOMOUS delivers it to the customer. */
export const KEWY_AUTONOMY_MODES = ["SHADOW", "AUTONOMOUS"] as const;
export type KewyAutonomyMode = (typeof KEWY_AUTONOMY_MODES)[number];

/**
 * kewy-ai's tenant config as returned by `GET /admin/tenants/:id/config`.
 *
 * Deliberately narrow: only the fields this proxy is willing to hand to the
 * browser are declared. Upstream redacts `apiKeyRef` already, and nothing
 * secret-shaped should be added here even if a future response carries it.
 */
export interface KewyTenantConfig {
  tenantId: string;
  /** The emergency stop, as stored. False = the agent is never invoked. */
  aiEnabled: boolean;
  /** Set by an operator upstream; forces the agent off regardless of aiEnabled. */
  killSwitch: boolean;
  autonomyMode: KewyAutonomyMode;
  personaName: string;
  locale: string;
  dailyCostCapJod: number | null;
  /** Whether the product sync (hjz catalogue -> knowledge) may run. */
  productSyncEnabled: boolean;
}

export interface KewyKillSwitchResult {
  aiEnabled: boolean;
  /** False when the tenant was already in the requested state — the toggle was
   *  a no-op, which the UI should not report as a change. */
  changed: boolean;
  reason?: string;
}
