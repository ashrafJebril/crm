import { Injectable } from "@nestjs/common";
import { UPSTREAM_RESPONSE_MAX_BYTES } from "./connector-catalog";
import type { UpstreamTool } from "./connector-tools";
import { parseSseMessages, safeFetch, SafeFetchError, type SafeFetchDeps } from "./safe-fetch";

/**
 * SP-23: the CRM as an MCP CLIENT of a vendor (or custom) MCP server.
 *
 * Ruling 2 spike (recorded in the task report): `@mastra/mcp` 1.18's client
 * accepts a custom `fetch` and exposes the raw `inputSchema`/`annotations`
 * through `toolDefinitions()`, so it could work; but its transport needs a
 * WHATWG fetch, while the SSRF pin needs Node's `https.request` with a fixed
 * `lookup`. This minimal client speaks MCP "streamable HTTP" (JSON-RPC POST,
 * JSON or SSE answer, the `Mcp-Session-Id` header) over `safe-fetch.ts`, so
 * every request — custom and curated — is guarded and pinned. No new
 * dependency. It sits behind `ConnectorUpstream`, so the Mastra client can
 * replace it without touching the proxy.
 */
export interface UpstreamTarget {
  url: string;
  /** Authorization and/or custom headers (never logged). */
  headers: Record<string, string>;
  /** A curated URL from code/env (may be a loopback stub outside production). */
  trusted: boolean;
}

export interface UpstreamCallResult {
  content: unknown[];
  isError: boolean;
  /** The response was over 1 MB and was cut, with a note. */
  truncated: boolean;
}

export interface ConnectorUpstream {
  initialize(target: UpstreamTarget): Promise<{ serverName: string | null }>;
  listTools(target: UpstreamTarget): Promise<UpstreamTool[]>;
  callTool(target: UpstreamTarget, name: string, args: Record<string, unknown>): Promise<UpstreamCallResult>;
}

export const CONNECTOR_UPSTREAM = Symbol("CONNECTOR_UPSTREAM");

/** The vendor refused our credentials (401/403). */
export class UpstreamAuthError extends Error {
  constructor(public readonly status: number) {
    super(`upstream_auth_${status}`);
    this.name = "UpstreamAuthError";
  }
}

/** Any other upstream failure, with a short safe reason. */
export class UpstreamError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "UpstreamError";
  }
}

const PROTOCOL = "2025-06-18";
/** Read cap for one upstream answer; the tool content is cut to 1 MB after parsing. */
const READ_MAX = 4 * UPSTREAM_RESPONSE_MAX_BYTES;
const TOOLS_MAX = 500;

/** Caps the content to UPSTREAM_RESPONSE_MAX_BYTES with a note. */
export function capContent(content: unknown[]): { content: unknown[]; truncated: boolean } {
  let used = 0;
  const out: unknown[] = [];
  for (const block of content) {
    const size = Buffer.byteLength(JSON.stringify(block) ?? "", "utf8");
    if (used + size <= UPSTREAM_RESPONSE_MAX_BYTES) {
      out.push(block);
      used += size;
      continue;
    }
    const b = block as { type?: unknown; text?: unknown };
    const room = UPSTREAM_RESPONSE_MAX_BYTES - used - 64;
    if (b?.type === "text" && typeof b.text === "string" && room > 0) out.push({ type: "text", text: b.text.slice(0, room) });
    out.push({ type: "text", text: "[The response was larger than 1 MB and was cut here.]" });
    return { content: out, truncated: true };
  }
  return { content: out, truncated: false };
}

@Injectable()
export class HttpConnectorUpstream implements ConnectorUpstream {
  /** Specs and verification may swap the transport. */
  deps?: SafeFetchDeps;
  private seq = 0;

  private async rpc(
    target: UpstreamTarget,
    method: string,
    params: unknown,
    session: string | null,
    notification = false,
  ): Promise<{ result: unknown; session: string | null }> {
    const id = ++this.seq;
    const headers: Record<string, string> = {
      ...target.headers,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL,
      "user-agent": "KewyCRM-Connectors/1",
    };
    if (session) headers["mcp-session-id"] = session;
    const body = JSON.stringify(notification ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params });
    let res;
    try {
      res = await safeFetch(target.url, { method: "POST", headers, body, trusted: target.trusted, maxBytes: READ_MAX }, this.deps);
    } catch (e) {
      if (e instanceof SafeFetchError) throw e;
      throw new UpstreamError("network");
    }
    if (res.status === 401 || res.status === 403) throw new UpstreamAuthError(res.status);
    const nextSession = res.headers["mcp-session-id"] ?? session;
    if (notification) return { result: null, session: nextSession };
    if (res.status < 200 || res.status >= 300) throw new UpstreamError(`http_${res.status}`);
    const type = (res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    let messages: unknown[];
    if (type === "text/event-stream") messages = parseSseMessages(res.body);
    else {
      try {
        messages = [JSON.parse(res.body)];
      } catch {
        throw new UpstreamError("invalid_response");
      }
    }
    const flat = messages.flatMap((m) => (Array.isArray(m) ? m : [m]));
    const msg = flat.find((m) => m && typeof m === "object" && (m as { id?: unknown }).id === id) as
      | { result?: unknown; error?: { message?: unknown } }
      | undefined;
    if (!msg) throw new UpstreamError("no_response");
    if (msg.error) throw new UpstreamError("rpc_error");
    return { result: msg.result, session: nextSession };
  }

  private async open(target: UpstreamTarget): Promise<{ session: string | null; serverName: string | null }> {
    const { result, session } = await this.rpc(
      target,
      "initialize",
      { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "kewy-crm-connectors", version: "1.0.0" } },
      null,
    );
    await this.rpc(target, "notifications/initialized", {}, session, true).catch(() => undefined);
    const info = (result as { serverInfo?: { name?: unknown } } | null)?.serverInfo;
    return { session, serverName: typeof info?.name === "string" ? info.name.slice(0, 120) : null };
  }

  async initialize(target: UpstreamTarget): Promise<{ serverName: string | null }> {
    const { serverName } = await this.open(target);
    return { serverName };
  }

  async listTools(target: UpstreamTarget): Promise<UpstreamTool[]> {
    const { session } = await this.open(target);
    const tools: UpstreamTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20 && tools.length < TOOLS_MAX; page++) {
      const { result } = await this.rpc(target, "tools/list", cursor ? { cursor } : {}, session);
      const r = (result ?? {}) as { tools?: unknown; nextCursor?: unknown };
      for (const t of Array.isArray(r.tools) ? r.tools : []) {
        if (!t || typeof t !== "object" || typeof (t as UpstreamTool).name !== "string") continue;
        const u = t as UpstreamTool;
        tools.push({
          name: u.name.slice(0, 200),
          title: typeof u.title === "string" ? u.title.slice(0, 200) : undefined,
          description: typeof u.description === "string" ? u.description.slice(0, 4000) : undefined,
          inputSchema: u.inputSchema ?? { type: "object" },
          annotations: u.annotations && typeof u.annotations === "object" ? u.annotations : null,
        });
      }
      if (typeof r.nextCursor !== "string" || !r.nextCursor) break;
      cursor = r.nextCursor;
    }
    return tools.slice(0, TOOLS_MAX);
  }

  async callTool(target: UpstreamTarget, name: string, args: Record<string, unknown>): Promise<UpstreamCallResult> {
    const { session } = await this.open(target);
    const { result } = await this.rpc(target, "tools/call", { name, arguments: args }, session);
    const r = (result ?? {}) as { content?: unknown; isError?: unknown };
    const capped = capContent(Array.isArray(r.content) ? r.content : []);
    return { content: capped.content, isError: r.isError === true, truncated: capped.truncated };
  }
}
