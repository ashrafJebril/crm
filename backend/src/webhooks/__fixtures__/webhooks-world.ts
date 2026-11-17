/**
 * SP-27 in-memory world for the webhook specs (not a runtime file). The REAL
 * WebhooksService, WebhookOutboxListener and WebhookDispatcher run over the
 * channels/test-prisma double (via the SP-26 members world); the transport is
 * a fake that never opens a socket.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { makeWorld, U, WS, WS2 } from "../../members/__fixtures__/members-world";
import type { SafeFetchDeps, SafeRequest } from "../../common/safe-fetch";
import { WebhooksService } from "../webhooks.service";
import { WebhookOutboxListener } from "../webhook-outbox.listener";
import { WebhookDispatcher } from "../webhook-dispatcher";

export { U, WS, WS2 };
export const T0 = new Date("2026-11-18T10:00:00.000Z");
export const PUBLIC_IP = "93.184.216.34";

export interface FakeTransport extends SafeFetchDeps {
  calls: SafeRequest[];
  statuses: number[];
  /** Host → addresses (default: the public IP). */
  dns: Record<string, string[]>;
  /** Resolves pending requests when set (for overlap tests). */
  gate?: Promise<void>;
}

export function fakeTransport(statuses: number[] = []): FakeTransport {
  const t: FakeTransport = {
    calls: [],
    statuses,
    dns: {},
    async resolve(host) {
      return (t.dns[host] ?? [PUBLIC_IP]).map((a) => ({ address: a, family: a.includes(":") ? 6 : 4 }));
    },
    async request(req) {
      t.calls.push(req);
      if (t.gate) await t.gate;
      return { status: t.statuses.length ? (t.statuses.shift() as number) : 200 };
    },
  };
  return t;
}

export function webhooksWorld() {
  process.env.TOKEN_ENC_KEY = process.env.TOKEN_ENC_KEY || "k".repeat(48);
  const w = makeWorld();
  const prisma: any = w.prisma;
  prisma.db.webhookEndpoint = [];
  prisma.db.webhookDelivery = [];
  prisma.db.contact.push(
    {
      id: "c1",
      workspaceId: WS,
      name: "Sara Ali",
      firstName: "Sara",
      lastName: "Ali",
      email: "sara@example.com",
      phone: "966500000001",
      industry: "retail",
      lifecycle: "lead",
      source: "whatsapp",
      value: "9000",
      lastSeen: "now",
      tags: JSON.stringify(["vip"]),
      convs: 2,
      externalSource: "whatsapp",
      externalId: "wa-123",
      hjzClientId: "hjz-9",
      ownerId: U.owner,
      marketingOptOut: true,
      notALead: false,
      createdAt: T0,
      updatedAt: T0,
    },
    { id: "c2", workspaceId: WS2, name: "Other", phone: null, industry: "x", lifecycle: "lead", source: "web", tags: "[]", createdAt: T0, updatedAt: T0 },
  );
  let now = T0;
  const clock = {
    get: () => now,
    set: (d: Date) => (now = d),
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
  };
  const notifications = { notify: jest.fn(async (_ws: string, ids: string[]) => ids.length) };
  const service = new WebhooksService(prisma, w.audit);
  service.now = clock.get;
  const listener = new WebhookOutboxListener(prisma);
  listener.now = clock.get;
  const transport = fakeTransport();
  const dispatcher = (t: FakeTransport = transport) => {
    const d = new WebhookDispatcher(prisma, { isLocked: async () => false } as never, w.permissions, notifications as never);
    d.now = clock.get;
    d.transport = t;
    return d;
  };
  return { ...w, prisma, db: prisma.db, clock, notifications, service, listener, transport, dispatcher };
}

/** An endpoint subscribed to `events`, plus its one-time secret. */
export async function endpoint(w: ReturnType<typeof webhooksWorld>, events = ["contact.created"], ws = WS, url = "https://hooks.example.com/in") {
  return w.service.create(ws, { userId: ws === WS ? U.owner : U.other }, { url, events });
}

export const headerOf = (req: SafeRequest, name: string) => req.headers[name.toLowerCase()];
