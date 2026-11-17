/**
 * SP-23 in-memory world for the connector specs (not a runtime file). The
 * REAL ConnectorsService, ConnectorAgentService (over the real LMcpService
 * with a fake l HTTP client), ConnectorProxyRpc, ConnectorProxyGuard and the
 * recorder run over the channels/test-prisma double. The upstream MCP server
 * is a fake that records every call: no network.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { makeFakePrisma } from "../../channels/test-prisma";
import { LMcpService } from "../../integrations/l-mcp.service";
import { ConnectorAgentService } from "../connector-agent.service";
import { ConnectorCallRecorder } from "../connector-call.recorder";
import { ConnectorCredentials, sealJson } from "../connector-credentials";
import { ConnectorProxyGuard } from "../connector-proxy.guard";
import { ConnectorProxyRpc } from "../connector-proxy.rpc";
import type { ConnectorUpstream, UpstreamTarget } from "../connector-upstream";
import type { StoredTool, UpstreamTool } from "../connector-tools";
import { ConnectorsService } from "../connectors.service";

export const WS = "ws1";
export const WS2 = "ws2";
export const NOW = new Date("2026-11-18T10:00:00.000Z");

export class FakeUpstream implements ConnectorUpstream {
  tools: UpstreamTool[] = [];
  calls: { url: string; name: string; args: unknown; headers: Record<string, string> }[] = [];
  lists: UpstreamTarget[] = [];
  result: { content: unknown[]; isError: boolean; truncated: boolean } = { content: [{ type: "text", text: "ok" }], isError: false, truncated: false };
  fail: Error | null = null;
  async initialize(target: UpstreamTarget) {
    if (this.fail) throw this.fail;
    this.lists.push(target);
    return { serverName: "fake" };
  }
  async listTools(target: UpstreamTarget) {
    if (this.fail) throw this.fail;
    this.lists.push(target);
    return this.tools;
  }
  async callTool(target: UpstreamTarget, name: string, args: Record<string, unknown>) {
    this.calls.push({ url: target.url, name, args, headers: target.headers });
    if (this.fail) throw this.fail;
    return this.result;
  }
}

export function connectorsWorld(opts: { lLinked?: boolean } = {}) {
  process.env.TOKEN_ENC_KEY = process.env.TOKEN_ENC_KEY || "k".repeat(48);
  const prisma: any = makeFakePrisma({
    workspace: [
      { id: WS, name: "Acme", lWorkspaceId: opts.lLinked === false ? null : "lws-1" },
      { id: WS2, name: "Other", lWorkspaceId: "lws-2" },
    ],
    connector: [],
    connectorCall: [],
    skillInstall: [],
  } as never);
  const lRequests: { path: string; method: string; body?: any }[] = [];
  let serverSeq = 0;
  const lClient = {
    request: jest.fn(async (path: string, init: { method?: string; body?: any } = {}) => {
      lRequests.push({ path, method: init.method ?? "GET", body: init.body });
      if ((init.method ?? "GET") === "POST" && /\/mcp-servers$/.test(path)) return { id: `lsrv_${++serverSeq}`, name: init.body?.name };
      return undefined;
    }),
  };
  const resolver = { resolveSlug: jest.fn(async () => "agent-1") };
  const lMcp = new LMcpService(prisma, lClient as never, resolver as never);
  const agent = new ConnectorAgentService(prisma, lMcp);
  const credentials = new ConnectorCredentials();
  const upstream = new FakeUpstream();
  const skills = { onConnectorChanged: jest.fn(async () => undefined) };
  const service = new ConnectorsService(prisma, agent, credentials, upstream, skills as never);
  service.now = () => NOW;
  const recorder = new ConnectorCallRecorder(prisma);
  const rpc = new ConnectorProxyRpc(recorder, credentials, upstream);
  const paymentLock = { isLocked: jest.fn(async () => false) };
  const guard = new ConnectorProxyGuard(prisma, paymentLock as never);
  return { prisma, db: prisma.db, lRequests, lClient, resolver, lMcp, agent, credentials, upstream, skills, service, recorder, rpc, paymentLock, guard };
}

export type World = ReturnType<typeof connectorsWorld>;

let rowSeq = 0;
/** Seeds an active connector with stored tools (and secret headers, optionally). */
export function seedConnector(w: World, over: Record<string, unknown> & { tools?: StoredTool[]; headers?: Record<string, string> } = {}) {
  const { headers, ...rest } = over;
  const row = {
    id: `conn_${++rowSeq}`,
    workspaceId: WS,
    provider: "custom",
    name: "Bookings",
    authKind: headers ? "headers" : "none",
    status: "active",
    serverUrl: "https://mcp.example.com/mcp",
    headersEnc: headers ? sealJson(headers) : null,
    tools: [],
    version: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...rest,
  };
  w.db.connector.push({ ...row, ...defaults(row) });
  return w.db.connector[w.db.connector.length - 1];
}

function defaults(row: Record<string, unknown>) {
  const base: Record<string, unknown> = {
    statusReason: null,
    tokenEnc: null,
    tokenExpiresAt: null,
    lServerId: null,
    agentBound: false,
    proxyTokenPrefix: null,
    proxyTokenHash: null,
    accountLabel: null,
    toolsScannedAt: null,
    connectedAt: NOW,
    disconnectedAt: null,
    sync: {},
  };
  for (const k of Object.keys(base)) if (row[k] !== undefined) delete base[k];
  return base;
}

export const tool = (name: string, kind: "read" | "write", access: "off" | "read" | "write", extra: Partial<StoredTool> = {}): StoredTool => ({
  name,
  title: null,
  description: `${name} description`,
  kind,
  access,
  inputSchema: { type: "object", properties: {}, additionalProperties: true },
  removedAt: null,
  ...extra,
});

/** A guard context for the proxy. */
export function proxyCtx(req: Record<string, unknown>) {
  return { switchToHttp: () => ({ getRequest: () => req }) } as never;
}
