import { HttpException, Injectable, Logger } from "@nestjs/common";
import { redactUrl } from "../common/redact-url";
import type { ZernioWhatsAppTemplate } from "./zernio.client";

const GRAPH = "https://graph.facebook.com/v21.0";

/** A WhatsApp number connected directly to Meta: its WABA and access token. */
export interface MetaWabaCredentials {
  wabaId: string;
  token: string;
}

/**
 * WhatsApp message templates straight on the Graph API, for numbers connected
 * directly to Meta (Embedded Signup, coexistence, pasted token) rather than
 * through Zernio.
 *
 * Results use the same shape as `ZernioWhatsAppTemplate` — Zernio proxies
 * these exact Graph fields — so TemplatesService reconciles both the same way.
 */
@Injectable()
export class MetaTemplatesClient {
  private readonly log = new Logger(MetaTemplatesClient.name);

  /** Every template on the WABA, following Graph paging. */
  async list(creds: MetaWabaCredentials): Promise<ZernioWhatsAppTemplate[]> {
    const fields = "id,name,status,category,language,components,rejected_reason";
    let url: string | undefined =
      `${GRAPH}/${creds.wabaId}/message_templates?fields=${fields}&limit=100`;
    const out: ZernioWhatsAppTemplate[] = [];
    // Hard stop so a paging loop can never spin forever.
    for (let page = 0; url && page < 50; page++) {
      const res: { data?: ZernioWhatsAppTemplate[]; paging?: { next?: string } } =
        await this.request("GET", url, creds.token);
      out.push(...(res.data ?? []));
      url = res.paging?.next;
    }
    return out;
  }

  async create(
    creds: MetaWabaCredentials,
    body: {
      name: string;
      category: "AUTHENTICATION" | "MARKETING" | "UTILITY";
      language: string;
      components?: Array<Record<string, unknown>>;
      libraryTemplateName?: string;
    },
  ): Promise<{ id: string | null; status: string; category?: string }> {
    const payload: Record<string, unknown> = {
      name: body.name,
      category: body.category,
      language: body.language,
    };
    if (body.libraryTemplateName) payload.library_template_name = body.libraryTemplateName;
    else payload.components = toMetaCasing(body.components ?? []);

    const res = await this.request<{ id?: string; status?: string; category?: string }>(
      "POST",
      `${GRAPH}/${creds.wabaId}/message_templates`,
      creds.token,
      payload,
    );
    return { id: res.id ?? null, status: res.status ?? "PENDING", category: res.category };
  }

  /** Edit a template's components. Meta re-reviews every edit. */
  async update(
    creds: MetaWabaCredentials,
    templateId: string,
    components: Array<Record<string, unknown>>,
  ): Promise<{ status: string }> {
    await this.request("POST", `${GRAPH}/${templateId}`, creds.token, {
      components: toMetaCasing(components),
    });
    return { status: "PENDING" };
  }

  /** Delete by name (every language of it), narrowed to one id when known. */
  async remove(creds: MetaWabaCredentials, name: string, templateId?: string | null) {
    const q = new URLSearchParams({ name });
    if (templateId) q.set("hsm_id", templateId);
    await this.request(
      "DELETE",
      `${GRAPH}/${creds.wabaId}/message_templates?${q.toString()}`,
      creds.token,
    );
  }

  private async request<T>(
    method: "GET" | "POST" | "DELETE",
    url: string,
    token: string,
    body?: unknown,
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      const timedOut = (e as Error).name === "TimeoutError";
      throw new HttpException(timedOut ? "Graph API timed out" : "Graph API unreachable", 504);
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = {};
    }
    if (!res.ok) {
      const err = (parsed as { error?: { message?: string; error_user_msg?: string } }).error;
      // error_user_msg is the human sentence ("Name already exists"); message
      // alone is often just "Invalid parameter".
      const msg = err?.error_user_msg || err?.message || `Graph error ${res.status}`;
      this.log.warn(`Graph ${method} ${redactUrl(url)} -> ${res.status} ${msg}`);
      throw new HttpException(msg, res.status >= 500 ? 502 : 400);
    }
    return parsed as T;
  }
}

/**
 * TemplatesService builds components with Zernio's lowercase discriminators;
 * the Graph API documents them uppercase (HEADER/BODY, TEXT/IMAGE,
 * QUICK_REPLY/URL). Normalize on the way out.
 */
function toMetaCasing(components: Array<Record<string, unknown>>) {
  return components.map((c) => {
    const out: Record<string, unknown> = { ...c, type: String(c.type ?? "").toUpperCase() };
    if (typeof c.format === "string") out.format = c.format.toUpperCase();
    if (Array.isArray(c.buttons)) {
      out.buttons = (c.buttons as Array<Record<string, unknown>>).map((b) => ({
        ...b,
        type: String(b.type ?? "").toUpperCase(),
      }));
    }
    return out;
  });
}
