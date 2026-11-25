/**
 * Spec-only harness for the SP-15 Meta Ads specs (not a runtime file; same
 * convention as ../channels/test-prisma.ts): a workspace with owner, admin,
 * agent, viewer and a custom "Ads lead" role, the fake Graph, and the real
 * service, notifier, scheduler and metrics.
 */
import { HttpException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { makeFakePrisma } from "../channels/test-prisma";
import { ADS_TOKEN, fakeGraph, marketingHandlers, META_ADS_ENV } from "../channels/whatsapp/test-graph";
import { encryptSecret } from "../common/token-crypto";
import { NotificationsService } from "../notifications/notifications.service";
import { PermissionService } from "../permissions/permission.service";
import { AdsMetricsService } from "../ad-attribution/ads-metrics.service";
import { appSecretProof, MetaAdsGraphClient } from "./meta-ads-graph.client";
import { MetaAdsNotifier } from "./meta-ads-notifier";
import { MetaAdsService, signOAuthState } from "./meta-ads.service";
import { MetaAdsSyncScheduler } from "./meta-ads-sync.scheduler";

export const JWT_SECRET = "meta-ads-spec-jwt-secret-0123456789abcdef";
export const ENC_KEY = "meta-ads-spec-token-enc-key-0123456789abcdef";
export const PROOF = () => appSecretProof(ADS_TOKEN, META_ADS_ENV.META_ADS_APP_SECRET);
export const T0 = new Date("2026-11-10T09:00:00.000Z");

export function world(opts: { graph?: ReturnType<typeof fakeGraph>; prisma?: ReturnType<typeof makeFakePrisma> } = {}) {
  // The OAuth state secret is derived from JWT_SECRET (as in the app).
  process.env.JWT_SECRET = JWT_SECRET;
  const prisma =
    opts.prisma ??
    makeFakePrisma({
      workspace: [
        { id: "wsA", timezone: "UTC" },
        { id: "wsB", timezone: "UTC" },
      ],
      role: [
        { id: "r_ads", workspaceId: "wsA", key: null, name: "Ads lead", nameAr: "Ads lead", isSystem: false, permissions: { connectors: ["view", "manage"] }, conversationVisibility: "all" },
      ],
      workspaceMember: [
        { id: "m1", workspaceId: "wsA", userId: "u_owner", role: "owner", roleId: null },
        { id: "m2", workspaceId: "wsA", userId: "u_admin", role: "admin", roleId: null },
        { id: "m3", workspaceId: "wsA", userId: "u_agent", role: "agent", roleId: null },
        { id: "m4", workspaceId: "wsA", userId: "u_viewer", role: "viewer", roleId: null },
        { id: "m5", workspaceId: "wsA", userId: "u_lead", role: "agent", roleId: "r_ads" },
        { id: "m6", workspaceId: "wsB", userId: "u_ownerB", role: "owner", roleId: null },
      ],
      user: [{ id: "u_owner", name: "Olivia Owner", email: "o@x" }],
    } as never);
  const graph = opts.graph ?? fakeGraph(marketingHandlers());
  const client = new MetaAdsGraphClient(graph.fetch);
  const jwt = new JwtService({ secret: JWT_SECRET });
  const perm = new PermissionService(prisma);
  const notifications = new NotificationsService(prisma, { emitToUser: jest.fn(), emitToWorkspace: jest.fn() } as never);
  const notify = jest.spyOn(notifications, "notify");
  const notifier = new MetaAdsNotifier(prisma, notifications, perm);
  const svc = new MetaAdsService(prisma, jwt, client, perm, notifier);
  const scheduler = new MetaAdsSyncScheduler(prisma, client, notifier);
  // Deterministic elapsed time: a real clock lets a loaded machine shift the
  // per-connection timestamps (now + elapsed) by a millisecond. Specs that
  // test elapsed time set their own clock.
  scheduler.clock = () => 0;
  const metrics = new AdsMetricsService(prisma);
  const stateOf = (url: string) => new URL(url).searchParams.get("state")!;
  const conn = (ws = "wsA") => prisma.db.metaAdsConnection.find((c: { workspaceId: string }) => c.workspaceId === ws);
  /** A state signed like `oauth/start` signs it (purpose and expiry overridable). */
  const signState = (payload: Record<string, unknown>, expiresIn: string | number = "10m") =>
    signOAuthState(jwt, { workspaceId: "wsA", userId: "u_owner", nonce: `n-${Math.random()}`, purpose: "meta_ads_oauth", ...payload }, expiresIn);
  return { prisma, graph, client, jwt, perm, notify, svc, scheduler, metrics, stateOf, conn, signState };
}

/** An active connection on act_111 (USD, Asia/Riyadh) holding the encrypted token. */
export function seedActive(w: ReturnType<typeof world>, over: Record<string, unknown> = {}) {
  const row = {
    id: "mac_1",
    workspaceId: "wsA",
    status: "active",
    statusReason: null,
    tokenEnc: encryptSecret(ADS_TOKEN),
    tokenExpiresAt: null,
    pendingTokenEnc: null,
    pendingExpiresAt: null,
    scopes: "ads_read",
    adAccountId: "act_111",
    adAccountName: "Main account",
    currency: "USD",
    timezone: "Asia/Riyadh",
    pageId: null,
    pageName: null,
    connectedById: "u_owner",
    connectedAt: T0,
    lastSyncedAt: null,
    lastSyncError: null,
    syncAttemptedAt: null,
    spendBackfilledAt: null,
    checkAttemptedAt: null,
    leadCheckpoints: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
  w.prisma.db.metaAdsConnection.push(row);
  return row;
}

export async function caught(p: Promise<unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const e = await p.then(
    () => {
      throw new Error("expected a rejection");
    },
    (err) => err,
  );
  if (!(e instanceof HttpException)) throw e;
  return { status: e.getStatus(), body: e.getResponse() as Record<string, unknown> };
}

