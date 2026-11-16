/**
 * SP-21 spec helper (not a runtime file): a fake website and the crawl
 * runner over the in-memory Prisma double. The fake network records every
 * DNS lookup and request; an unknown host or URL throws (no live calls).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { PageFetchDeps, PageRequest, ResolvedAddress } from "../../common/public-fetch";
import { PermissionService } from "../../permissions/permission.service";
import { SYSTEM_ROLES } from "../../permissions/system-roles";
import { A, B, knowledgeWorld } from "../knowledge-test-world";
import { CrawlRunner } from "./crawl-runner";

export { A, B };
export const PUBLIC_IP = "93.184.216.34";

export interface FakePage {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}

/** A scripted network. `dns` maps hosts to addresses (a function may change answers between lookups). */
export function fakeNet(opts: { dns: Record<string, string[] | (() => string[])>; pages: Record<string, FakePage | (() => FakePage)> }) {
  const requests: PageRequest[] = [];
  const lookups: string[] = [];
  const deps: PageFetchDeps = {
    async resolve(host) {
      lookups.push(host);
      const a = opts.dns[host];
      if (!a) throw new Error(`unexpected DNS lookup: ${host}`);
      const list = typeof a === "function" ? a() : a;
      return list.map((address): ResolvedAddress => ({ address, family: address.includes(":") ? 6 : 4 }));
    },
    async request(req) {
      requests.push(req);
      const entry = opts.pages[req.url.toString()];
      if (!entry) throw new Error(`unexpected request: ${req.url}`);
      const page = typeof entry === "function" ? entry() : entry;
      const body = page.body ?? "";
      return {
        status: page.status ?? 200,
        headers: { "content-type": "text/html; charset=utf-8", ...(page.headers ?? {}) },
        body: (async function* () {
          yield Buffer.from(body);
        })(),
        abort: () => undefined,
      };
    },
  };
  return { deps, requests, lookups, urls: () => requests.map((r) => r.url.toString()) };
}

export const html = (title: string, text: string, links: string[] = []) =>
  `<html><head><title>${title}</title></head><body><p>${text}</p>${links.map((l) => `<a href="${l}">link</a>`).join("")}</body></html>`;

/** The knowledge world plus members/roles for membersWith, a notifier and a runner over `deps`. */
export function crawlWorld(deps: PageFetchDeps) {
  const w = knowledgeWorld();
  const role = (key: "owner" | "admin" | "agent" | "viewer") => ({
    id: `r_${key}`,
    workspaceId: A,
    key,
    name: key,
    nameAr: key,
    isSystem: true,
    permissions: SYSTEM_ROLES[key].permissions,
    conversationVisibility: "all",
  });
  w.db.role = [
    role("owner"),
    role("admin"),
    role("agent"),
    role("viewer"),
    { id: "r_kb", workspaceId: A, key: null, name: "KB editor", nameAr: "KB", isSystem: false, permissions: { knowledge: ["view", "update"] }, conversationVisibility: "all" },
  ];
  w.db.workspaceMember = [
    { id: "m1", workspaceId: A, userId: "uOwner", role: "owner", roleId: null },
    { id: "m2", workspaceId: A, userId: "uAdmin", role: "admin", roleId: null },
    { id: "m3", workspaceId: A, userId: "uAgent", role: "agent", roleId: null },
    { id: "m4", workspaceId: A, userId: "uViewer", role: "viewer", roleId: null },
    { id: "m5", workspaceId: A, userId: "uKb", role: "agent", roleId: "r_kb" },
    { id: "m9", workspaceId: B, userId: "uOther", role: "owner", roleId: null },
  ];
  // The double resolves `include: { roleRef: true }` through the role table.
  const perm = new PermissionService(w.prisma as any);
  const notifications = { notify: jest.fn(async () => 1) };
  const sleep = jest.fn(async () => undefined);
  const publisher = { schedule: jest.fn() };
  const runner = new CrawlRunner(w.prisma as any, perm, notifications as any, deps, sleep, publisher);
  return { ...w, perm, notifications, sleep, publisher, runner };
}

let seq = 0;
/** A website source row as created by WebsitesService.create. */
export function website(db: Record<string, any[]>, over: Record<string, unknown> = {}) {
  const row = {
    id: `web_${++seq}`,
    workspaceId: A,
    kind: "website",
    status: "queued",
    error: null,
    title: "shop.example",
    url: "https://shop.example/",
    scope: "site",
    schedule: "weekly",
    nextSyncAt: new Date(),
    lastSyncAt: null,
    syncStartedAt: null,
    refreshRequestedAt: null,
    consecutiveFailures: 0,
    lastRun: null,
    itemCount: 0,
    publishState: "none",
    upstream: null,
    legacyRef: null,
    version: 0,
    order: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
  db.knowledgeSource.push(row);
  return row;
}
