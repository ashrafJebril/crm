/**
 * SP-23 Task 2 world: the Task 1 connectors world plus a fake vendor
 * (authorization server + nothing else) behind the SSRF guard's transport,
 * the real state/token/attention/OAuth services and a real JwtService. No
 * network: the transport answers in memory.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Readable } from "node:stream";
import { JwtService } from "@nestjs/jwt";
import { connectorsWorld } from "./connectors-world";
import { ConnectorStatusService } from "../connector-status.service";
import { ConnectorAttentionService } from "../connector-attention.service";
import { ConnectorOAuthHttp } from "../connector-oauth-http";
import { ConnectorTokenService } from "../connector-token.service";
import { ConnectorOAuthService } from "../connector-oauth.service";
import { ConnectorProxyRpc } from "../connector-proxy.rpc";
import { ConnectorsService } from "../connectors.service";
import { ConnectorRefreshScheduler } from "../connector-refresh.scheduler";
import type { SafeFetchDeps, SafeRequest } from "../safe-fetch";

process.env.JWT_SECRET = process.env.JWT_SECRET || "j".repeat(48);

export const AS = {
  calendly: "https://auth.calendly.test",
  hubspot: "https://auth.hubspot.test",
};

export interface VendorFake extends SafeFetchDeps {
  requests: { url: string; method: string; form: Record<string, string>; json: any; headers: Record<string, string> }[];
  /** Answers for the next token requests (else a default rotation). */
  tokenAnswers: Array<{ status: number; body: any } | ((form: Record<string, string>) => { status: number; body: any })>;
  registrations: number;
  issued: number;
  gate?: Promise<void>;
}

export function vendorFake(): VendorFake {
  const v: VendorFake = {
    requests: [],
    tokenAnswers: [],
    registrations: 0,
    issued: 0,
    async resolve() {
      return [{ address: "93.184.216.34", family: 4 }];
    },
    async request(req: SafeRequest) {
      const form = req.headers["content-type"] === "application/x-www-form-urlencoded" ? Object.fromEntries(new URLSearchParams(req.body ?? "")) : {};
      let json: any = null;
      try {
        json = req.headers["content-type"] === "application/json" && req.body ? JSON.parse(req.body) : null;
      } catch {
        json = null;
      }
      v.requests.push({ url: req.url.toString(), method: req.method, form, json, headers: req.headers });
      const answer = (status: number, body: any) => ({
        status,
        headers: { "content-type": "application/json" },
        body: Readable.from([Buffer.from(JSON.stringify(body))]),
        abort: () => undefined,
      });
      const u = req.url;
      if (u.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        return answer(200, { resource: u.origin, authorization_servers: [u.hostname.includes("hubspot") ? AS.hubspot : AS.calendly] });
      }
      if (u.pathname === "/.well-known/oauth-authorization-server") {
        const base = u.origin;
        return answer(200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          revocation_endpoint: `${base}/revoke`,
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (u.pathname === "/register") {
        v.registrations++;
        return answer(201, { client_id: `dcr_client_${v.registrations}` });
      }
      if (u.pathname === "/revoke") return answer(200, {});
      if (u.pathname === "/token") {
        if (v.gate) await v.gate;
        const next = v.tokenAnswers.shift();
        if (next) {
          const a = typeof next === "function" ? next(form) : next;
          return answer(a.status, a.body);
        }
        v.issued++;
        return answer(200, { access_token: `at_${v.issued}`, refresh_token: `rt_${v.issued}`, expires_in: 3600, token_type: "Bearer" });
      }
      return answer(404, {});
    },
  };
  return v;
}

export function oauthWorld(opts: { canConnect?: () => boolean } = {}) {
  const w = connectorsWorld();
  const vendor = vendorFake();
  const http = new ConnectorOAuthHttp();
  http.deps = vendor;
  const notifications = { notify: jest.fn(async (_ws: string, ids: string[]) => ids.length) };
  const managers = ["u_owner", "u_admin"];
  const perms: any = {
    invalidate: jest.fn(),
    effective: jest.fn(async () => ({ key: "owner" })),
    can: jest.fn((_eff: unknown, p: string) => (p === "connectors.create" ? (opts.canConnect ? opts.canConnect() : true) : true)),
    membersWith: jest.fn(async (_ws: string, p: string) => (p === "connectors.manage" ? managers : [])),
  };
  const status = new ConnectorStatusService(w.prisma, w.skills as never);
  const attention = new ConnectorAttentionService(status, perms, notifications as never);
  const tokens = new ConnectorTokenService(w.prisma, http, attention, w.credentials);
  const jwt = new JwtService({});
  const oauth = new ConnectorOAuthService(w.prisma, jwt, perms, http, status, w.agent, w.recorder, w.upstream);
  const service = new ConnectorsService(w.prisma, w.agent, w.credentials, w.upstream, w.skills as never, tokens, status);
  const rpc = new ConnectorProxyRpc(w.recorder, w.credentials, w.upstream, tokens, attention);
  const scheduler = new ConnectorRefreshScheduler(w.prisma, tokens);
  let now = new Date("2026-11-18T10:00:00.000Z");
  const clock = { get: () => now, set: (d: Date) => (now = d), advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
  tokens.now = clock.get;
  oauth.now = clock.get;
  service.now = clock.get;
  return { ...w, vendor, http, notifications, perms, status, attention, tokens, jwt, oauth, service, rpc, scheduler, clock };
}

export type OAuthWorld = ReturnType<typeof oauthWorld>;

/** start → the state and the challenge from the authorize URL. */
export async function startConnect(w: OAuthWorld, provider = "calendly", ws = "ws1", userId = "u_owner") {
  const { authorizeUrl } = await w.oauth.start(ws, userId, provider);
  const u = new URL(authorizeUrl);
  return { url: u, state: u.searchParams.get("state")!, challenge: u.searchParams.get("code_challenge")!, connector: w.db.connector.find((c: any) => c.provider === provider && c.workspaceId === ws) };
}

/** start + callback: an active connector. */
export async function connect(w: OAuthWorld, provider = "calendly") {
  const s = await startConnect(w, provider);
  const outcome = await w.oauth.callback({ code: "code_1", state: s.state });
  return { ...s, outcome, connector: w.db.connector.find((c: any) => c.id === s.connector.id) };
}
