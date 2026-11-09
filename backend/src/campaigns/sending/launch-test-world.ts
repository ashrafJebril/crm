/**
 * SP-13 test world for the background launch (not a runtime file; same
 * convention as channels/test-prisma.ts): the in-memory Prisma double, a
 * stateful fake Zernio that behaves like the real API where the runner
 * depends on it, and the runner, scheduler and services wired over them.
 *
 * The fake Zernio:
 * - keeps broadcasts with their status, recipients (re-adding a phone is
 *   counted as `skipped`, as Zernio does) and a name for draft adoption;
 * - refuses to send, schedule or add to a broadcast that is not a draft,
 *   and to delete one that is not a draft;
 * - replays a direct send by Idempotency-Key (Zernio keeps keys 24 h);
 * - records every message that would reach a phone in `deliveries`.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { HttpException, NotFoundException } from "@nestjs/common";
import { makeFakePrisma } from "../../channels/test-prisma";
import { RecipientTrackerService } from "../tracking/recipient-tracker.service";
import { CampaignSendService } from "../campaign-send.service";
import { CampaignReportService } from "../campaign-report.service";
import { CampaignLaunchRunner } from "./campaign-launch-runner.service";
import { CampaignLaunchScheduler } from "./campaign-launch.scheduler";
import { CampaignPreviewService } from "./campaign-preview.service";
import type { ZernioBudget } from "./zernio-budget";

export const WS = "ws1";
export const ME = "u-launcher";

export interface Delivery {
  phone: string;
  accountId: string;
  via: "broadcast" | "direct";
  broadcastId?: string;
  params?: string[];
  headerMedia?: unknown;
  key?: string;
}

export function fakeZernio(templates: Array<Record<string, unknown>>) {
  let seq = 0;
  const broadcasts = new Map<string, any>();
  const deliveries: Delivery[] = [];
  const replay = new Map<string, { messageId: string; conversationId: string }>();
  const notFound = () => new HttpException("Broadcast not found", 404);
  const get = (id: string) => {
    const b = broadcasts.get(id);
    if (!b) throw notFound();
    return b;
  };
  const deliver = (b: any) => {
    for (const phone of b.recipients) deliveries.push({ phone, accountId: b.accountId, via: "broadcast", broadcastId: b.id });
  };
  const z = {
    broadcasts,
    deliveries,
    whatsappTemplates: jest.fn(async (_accountId: string) => templates),
    bulkCreateContacts: jest.fn(async (_p: string, _a: string, contacts: unknown[]) => ({ created: contacts.length, skipped: 0, errors: 0 })),
    createWhatsAppBroadcast: jest.fn(async (input: any) => {
      const id = `zb${++seq}`;
      broadcasts.set(id, { id, ...input, status: "draft", recipients: new Set<string>() });
      return id;
    }),
    listBroadcasts: jest.fn(async (opts: { profileId: string; status?: string }) =>
      [...broadcasts.values()]
        .filter((b) => b.profileId === opts.profileId && (!opts.status || b.status === opts.status))
        .map((b) => ({ id: b.id, name: b.name, status: b.status })),
    ),
    addBroadcastRecipients: jest.fn(async (id: string, phones: string[]) => {
      const b = get(id);
      if (b.status !== "draft") throw new HttpException("Broadcast is not a draft", 400);
      let added = 0;
      let skipped = 0;
      for (const p of phones) {
        if (b.recipients.has(p)) skipped++;
        else {
          b.recipients.add(p);
          added++;
        }
      }
      return { added, skipped };
    }),
    getBroadcast: jest.fn(async (id: string) => {
      const b = get(id);
      return { status: b.status, recipientCount: b.recipients.size, sent: 0, delivered: 0, read: 0, failed: 0 };
    }),
    sendBroadcast: jest.fn(async (id: string) => {
      const b = get(id);
      if (b.status !== "draft") throw new HttpException("Broadcast already sent", 400);
      b.status = "sending";
      deliver(b);
    }),
    scheduleBroadcast: jest.fn(async (id: string, at: string) => {
      const b = get(id);
      if (b.status !== "draft") throw new HttpException("Broadcast already scheduled", 400);
      b.status = "scheduled";
      b.scheduledAt = at;
      deliver(b);
    }),
    cancelBroadcast: jest.fn(async (id: string) => {
      const b = get(id);
      if (b.status === "scheduled") {
        for (let i = deliveries.length - 1; i >= 0; i--) if (deliveries[i].broadcastId === id) deliveries.splice(i, 1);
      }
      b.status = "cancelled";
    }),
    deleteBroadcast: jest.fn(async (id: string) => {
      const b = get(id);
      if (b.status !== "draft") throw new HttpException("Only drafts can be deleted", 400);
      broadcasts.delete(id);
    }),
    sendTemplateToPhone: jest.fn(async (input: any) => {
      const seen = replay.get(input.idempotencyKey);
      if (seen) return seen;
      deliveries.push({
        phone: input.phone,
        accountId: input.accountId,
        via: "direct",
        params: input.templateParams,
        headerMedia: input.headerMedia,
        key: input.idempotencyKey,
      });
      const res = { messageId: `zm${++seq}`, conversationId: `zc${seq}` };
      replay.set(input.idempotencyKey, res);
      return res;
    }),
    listBroadcastRecipients: jest.fn(async () => ({ recipients: [], pagination: { total: 0, limit: 100, skip: 0, hasMore: false }, summary: {} })),
  };
  return z;
}

export type FakeZernio = ReturnType<typeof fakeZernio>;

export const channel = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  workspaceId: WS,
  kind: "whatsapp",
  provider: "zernio",
  externalId: `acc-${id}`,
  displayName: `Number ${id}`,
  phoneNumber: `+96279000${id.charCodeAt(0)}`,
  status: "active",
  isDefault: false,
  integrationId: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  ...over,
});

export const contact = (id: string, name: string, phone: string | null, over: Record<string, unknown> = {}) => ({
  id,
  workspaceId: WS,
  name,
  firstName: null,
  lastName: null,
  phone,
  email: null,
  lifecycle: "lead",
  marketingOptOut: false,
  ...over,
});

/** A Zernio approved copy of the campaign template. */
export const zernioCopy = (body: string, name = "svc", language = "en") => ({
  id: `t-${name}`,
  name,
  language,
  status: "APPROVED",
  category: "MARKETING",
  components: [{ type: "BODY", text: body }],
});

/** A budget that never waits (the real one is covered by zernio-budget.spec). */
export const freeBudget = () => {
  const takes = { campaign: 0, direct: 0 };
  const budget = {
    campaign: { rpm: 300, take: jest.fn(async () => void takes.campaign++) },
    direct: { rpm: 120, take: jest.fn(async () => void takes.direct++) },
  } as unknown as ZernioBudget;
  return { budget, takes };
};

/** A transient (retryable) database error, as a crash stand-in. */
export const crash = () => Object.assign(new Error("Can't reach database server (injected crash)"), { code: "P1001" });

/**
 * Replaces `delegate[method]` so the first call matching `when` rejects with
 * a transient error (the process "dies" at that boundary); every other call
 * goes through.
 */
export function crashOnce(delegate: any, method: string, when: (args: any, n: number) => boolean) {
  const real = delegate[method];
  let n = 0;
  let done = false;
  delegate[method] = jest.fn((a: any) => {
    n++;
    if (!done && when(a, n)) {
      done = true;
      return Promise.reject(crash());
    }
    return real(a);
  });
  return () => done;
}

export interface WorldOpts {
  senders?: string[];
  channels?: Array<Record<string, unknown>>;
  contacts?: Array<Record<string, unknown>>;
  body?: string;
  varMap?: Record<string, unknown> | null;
  campaign?: Record<string, unknown>;
  template?: Record<string, unknown>;
  customFieldDef?: Array<Record<string, unknown>>;
  customFieldValue?: Array<Record<string, unknown>>;
  media?: Array<Record<string, unknown>>;
  zernioTemplates?: Array<Record<string, unknown>>;
}

export function world(opts: WorldOpts = {}) {
  const body = opts.body ?? "Hello";
  const prisma: any = makeFakePrisma({
    workspace: [{ id: WS, plan: "pro", lang: "en", zernioProfileId: "prof1" }],
    channel: opts.channels ?? [channel("A", { isDefault: true }), channel("B"), channel("C")],
    contact: (opts.contacts ?? []) as never,
    template: [{ id: "tpl", workspaceId: WS, name: "svc", lang: "en", status: "approved", body, headerType: null, headerContent: null, buttons: null, ...opts.template }],
    campaign: [
      {
        id: "camp",
        workspaceId: WS,
        name: "Service reminder",
        status: "draft",
        audience: "All",
        channel: "Broadcast",
        segmentId: null,
        templateId: "tpl",
        zernioBroadcastId: null,
        senderChannelIds: opts.senders ?? [],
        senderChannelId: opts.senders?.[0] ?? null,
        varMap: opts.varMap ?? null,
        recipients: 0,
        sent: 0,
        delivered: 0,
        read: 0,
        failed: 0,
        replied: 0,
        skipped: 0,
        lastError: null,
        statsSyncedAt: null,
        ...opts.campaign,
      },
    ],
    customFieldDef: (opts.customFieldDef ?? []) as never,
    customFieldValue: (opts.customFieldValue ?? []) as never,
    media: (opts.media ?? []) as never,
  });
  const zernio = fakeZernio(opts.zernioTemplates ?? [zernioCopy(body)]);
  const media = {
    get: jest.fn(async (ws: string, id: string) => {
      const row = (prisma.db.media as any[]).find((m) => m.id === id && m.workspaceId === ws);
      if (!row) throw new NotFoundException("Media not found");
      return row;
    }),
    resolveExternalUrl: jest.fn(async (_ws: string, id: string, ttl: number) => `https://cdn.test/${id}?ttl=${ttl}`),
  };
  const notifications = { notify: jest.fn(async () => 1) };
  const tracker = new RecipientTrackerService(prisma);
  const { budget, takes } = freeBudget();
  const makeRunner = () => {
    const r = new CampaignLaunchRunner(prisma, zernio as never, media as never, notifications as never, tracker);
    r.budget = budget;
    r.sleep = async () => {};
    return r;
  };
  const runner = makeRunner();
  const scheduler = new CampaignLaunchScheduler(prisma, runner, tracker);
  const isLocked = jest.fn(async () => false);
  const send = new CampaignSendService(prisma, zernio as never, { isLocked } as never, tracker, runner, media as never);
  const preview = new CampaignPreviewService(prisma, zernio as never, media as never);
  const report = new CampaignReportService(prisma);
  const camp = () => prisma.db.campaign.find((c: any) => c.id === "camp");
  const rows = () => (prisma.db.campaignRecipient as any[]).filter((r) => r.campaignId === "camp");
  const partitions = () => (prisma.db.campaignBroadcast ?? []).filter((b: any) => b.campaignId === "camp");
  /** Launch through the service, then wait for the background job. */
  const launch = async (input: { mode: "now" | "schedule"; scheduledAt?: string; variables?: any[] } = { mode: "now" }) => {
    const res = await send.launch(WS, "camp", input, { userId: ME });
    await runner.idle();
    return res;
  };
  /** The crash-resume step: make the lease stale and let the scheduler resume the job. */
  const resume = async (afterMs = 3 * 60_000) => {
    const n = await scheduler.sweep(new Date(Date.now() + afterMs));
    await runner.idle();
    return n;
  };
  return { prisma, zernio, media, notifications, tracker, runner, makeRunner, scheduler, send, preview, report, isLocked, budget, takes, camp, rows, partitions, launch, resume };
}

/** The report service's raw insights queries, evaluated in JS (as campaign-report.service.spec does). */
export function withRawInsights(prisma: any) {
  prisma.$queryRaw = jest.fn(async (strings: TemplateStringsArray, ...vals: any[]) => {
    const sql = strings.join("?");
    const [ws, campaignId] = vals;
    const rows = (prisma.db.campaignRecipient as any[]).filter((r) => r.workspaceId === ws && r.campaignId === campaignId);
    if (sql.includes('"readAt" - "sentAt"')) return [{ withinHour: 0, oneToSix: 0, sixToDay: 0, afterDay: 0 }];
    if (sql.includes('GROUP BY "buttonPayload"')) return [];
    if (sql.includes('GROUP BY "failureCode"')) {
      const g = new Map<string | null, number>();
      for (const r of rows.filter((x) => ["failed", "skipped"].includes(x.status))) g.set(r.failureCode, (g.get(r.failureCode) ?? 0) + 1);
      return [...g.entries()].map(([code, count]) => ({ code, reason: null, count }));
    }
    throw new Error(`unexpected SQL ${sql}`);
  });
}

/** Phones each reachable recipient received, as counts. */
export function deliveryCounts(z: FakeZernio): Map<string, number> {
  const m = new Map<string, number>();
  for (const d of z.deliveries) m.set(d.phone, (m.get(d.phone) ?? 0) + 1);
  return m;
}
