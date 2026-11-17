/* eslint-disable @typescript-eslint/no-explicit-any */
import { Logger } from "@nestjs/common";
import { endpoint, U, webhooksWorld, WS, WS2 } from "./__fixtures__/webhooks-world";
import { WEBHOOK_ENDPOINTS_MAX } from "./webhook-events";
import { WebhookRetentionScheduler } from "./webhook-retention.scheduler";
import { WEBHOOK_ERROR_KEYS, webhookError, webhookErrorStatus } from "./webhook-errors";

const owner = { userId: U.owner };
const fail = (p: Promise<unknown>) => p.then(() => null, (e: any) => ({ status: e.getStatus(), message: e.getResponse().message }));

describe("WebhooksService", () => {
  it("secret encrypted, shown once, never logged", async () => {
    const w = webhooksWorld();
    const lines: string[] = [];
    const spies = (["log", "warn", "error", "debug", "verbose"] as const).flatMap((m) => [
      jest.spyOn(Logger.prototype, m).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" "))),
      jest.spyOn(Logger, m).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" "))),
    ]);
    const cons = (["log", "warn", "error", "info", "debug"] as const).map((m) =>
      jest.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" "))),
    );
    let secrets: string[] = [];
    try {
      const ep = await endpoint(w);
      expect(ep.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
      const row = w.db.webhookEndpoint[0];
      expect(row.secretEnc.startsWith("enc:v1:")).toBe(true);
      expect(row.secretEnc).not.toContain(ep.secret);
      const { secret: rotated } = await w.service.rotateSecret(WS, owner, ep.id);
      secrets = [ep.secret, rotated];
      const listed = JSON.stringify(await w.service.list(WS));
      const updated = JSON.stringify(await w.service.update(WS, owner, ep.id, { description: "Zap" }));
      for (const s of secrets) {
        expect(listed).not.toContain(s);
        expect(updated).not.toContain(s);
        expect(JSON.stringify(w.db.webhookEndpoint)).not.toContain(s);
        expect(JSON.stringify(w.db.auditLog)).not.toContain(s);
      }
      expect(listed).not.toContain("secretEnc");
      // Dispatching, failing and disabling log nothing secret either.
      await w.service.test(WS, ep.id);
      w.transport.statuses.push(500);
      await w.dispatcher().tick();
      w.transport.dns["hooks.example.com"] = ["127.0.0.1"];
      w.clock.advance(120_000);
      await w.dispatcher().tick();
    } finally {
      for (const s of [...spies, ...cons]) s.mockRestore();
    }
    const all = lines.join("\n");
    expect(all).not.toMatch(/whsec_/);
    for (const s of secrets) expect(all).not.toContain(s);
    expect(all).not.toMatch(/x-crm-signature|v1=/i);
  });

  it("create refuses without TOKEN_ENC_KEY in production", async () => {
    const w = webhooksWorld();
    const ep = await endpoint(w);
    const key = process.env.TOKEN_ENC_KEY;
    const env = process.env.NODE_ENV;
    delete process.env.TOKEN_ENC_KEY;
    process.env.NODE_ENV = "production";
    try {
      expect(await fail(endpoint(w))).toEqual({ status: 503, message: "webhooks.encryption_unavailable" });
      expect(await fail(w.service.rotateSecret(WS, owner, ep.id))).toEqual({ status: 503, message: "webhooks.encryption_unavailable" });
      expect(w.db.webhookEndpoint).toHaveLength(1);
    } finally {
      process.env.TOKEN_ENC_KEY = key;
      process.env.NODE_ENV = env;
    }
  });

  it("url is immutable", async () => {
    const w = webhooksWorld();
    const ep = await endpoint(w);
    expect(await fail(w.service.update(WS, owner, ep.id, { url: "https://other.example.com/x" }))).toEqual({
      status: 400,
      message: "webhooks.url_immutable",
    });
    expect(w.db.webhookEndpoint[0].url).toBe("https://hooks.example.com/in");
    // Events, description and the switch are editable.
    const out = await w.service.update(WS, owner, ep.id, { events: ["ticket.created", "contact.created"], description: "CRM sync", active: false });
    expect(out).toMatchObject({ events: ["contact.created", "ticket.created"], description: "CRM sync", active: false, disabledReason: "manual" });
  });

  it("foreign endpoint or delivery id is 404", async () => {
    const w = webhooksWorld();
    const mine = await endpoint(w);
    const theirs = await endpoint(w, ["contact.created"], WS2);
    const { deliveryId } = await w.service.test(WS2, theirs.id);
    const nf = { status: 404, message: "webhooks.not_found" };
    expect(await fail(w.service.update(WS, owner, theirs.id, { description: "x" }))).toEqual(nf);
    expect(await fail(w.service.remove(WS, owner, theirs.id))).toEqual(nf);
    expect(await fail(w.service.rotateSecret(WS, owner, theirs.id))).toEqual(nf);
    expect(await fail(w.service.test(WS, theirs.id))).toEqual(nf);
    expect(await fail(w.service.deliveries(WS, theirs.id, {}))).toEqual(nf);
    expect(await fail(w.service.delivery(WS, theirs.id, deliveryId))).toEqual(nf);
    // Another endpoint's delivery through my endpoint id.
    expect(await fail(w.service.delivery(WS, mine.id, deliveryId))).toEqual(nf);
    expect(await fail(w.service.redeliver(WS, mine.id, deliveryId))).toEqual(nf);
    expect(w.db.webhookEndpoint).toHaveLength(2);
  });

  it("validates the URL, events and the endpoint limit at create", async () => {
    const w = webhooksWorld();
    for (const url of ["http://hooks.example.com/x", "https://10.0.0.1/x", "https://localhost/x", "https://hooks.example.com:22/x", "https://169.254.169.254/latest"]) {
      expect({ url, r: await fail(w.service.create(WS, owner, { url, events: ["contact.created"] })) }).toEqual({
        url,
        r: { status: 400, message: "webhooks.unsafe_url" },
      });
    }
    for (const events of [[], ["ping"], ["contact.deleted"], "contact.created"]) {
      expect(await fail(w.service.create(WS, owner, { url: "https://hooks.example.com/x", events }))).toEqual({
        status: 400,
        message: "webhooks.invalid_events",
      });
    }
    for (let i = 0; i < WEBHOOK_ENDPOINTS_MAX; i++) await endpoint(w);
    expect(await fail(endpoint(w))).toEqual({ status: 409, message: "webhooks.limit_reached" });
  });

  it("test, delivery log and redeliver", async () => {
    const w = webhooksWorld();
    const ep = await endpoint(w);
    const { deliveryId } = await w.service.test(WS, ep.id);
    const log = await w.service.deliveries(WS, ep.id, {});
    expect(log.items).toEqual([expect.objectContaining({ id: deliveryId, event: "ping", status: "pending", attempts: 0 })]);
    expect(Object.keys(log.items[0])).not.toContain("payload");
    const one = await w.service.delivery(WS, ep.id, deliveryId);
    expect(one.payload).toMatchObject({ type: "ping", workspaceId: WS, data: { endpointId: ep.id } });
    const r1 = await w.service.redeliver(WS, ep.id, deliveryId);
    const r2 = await w.service.redeliver(WS, ep.id, r1.deliveryId);
    const ids = w.db.webhookDelivery.map((d: any) => d.eventId);
    expect(ids[1]).toBe(`${ids[0]}:r1`);
    expect(ids[2]).toBe(`${ids[0]}:r2`);
    expect(r2.deliveryId).not.toBe(r1.deliveryId);
    expect((await w.service.deliveries(WS, ep.id, { status: "delivered" })).items).toEqual([]);
  });

  it("retention deletes only final deliveries older than 30 days", async () => {
    const w = webhooksWorld();
    const ep = await endpoint(w);
    const old = new Date(Date.parse("2026-10-01T00:00:00Z"));
    const fresh = new Date(Date.parse("2026-11-17T00:00:00Z"));
    for (const [id, status, createdAt] of [
      ["d_old_delivered", "delivered", old],
      ["d_old_failed", "failed", old],
      ["d_old_pending", "pending", old],
      ["d_new_delivered", "delivered", fresh],
    ] as const) {
      w.db.webhookDelivery.push({ id, workspaceId: WS, endpointId: ep.id, eventId: id, event: "ping", payload: {}, status, attempts: 1, createdAt });
    }
    const r = new WebhookRetentionScheduler(w.prisma);
    r.now = w.clock.get;
    expect(await r.sweep()).toBe(2);
    expect(w.db.webhookDelivery.map((d: any) => d.id).sort()).toEqual(["d_new_delivered", "d_old_pending"]);
  });

  it("every webhook error key carries its status", () => {
    for (const key of WEBHOOK_ERROR_KEYS) {
      expect(webhookError(key).getStatus()).toBe(webhookErrorStatus(key));
      expect((webhookError(key).getResponse() as any).message).toBe(key);
    }
  });
});
