/* eslint-disable @typescript-eslint/no-explicit-any */
import { verify } from "./webhook-signature";
import { WEBHOOK_BACKOFF_MS, WEBHOOK_MAX_ATTEMPTS } from "./webhook-events";
import { endpoint, fakeTransport, headerOf, PUBLIC_IP, T0, U, webhooksWorld, WS } from "./__fixtures__/webhooks-world";

const MIN = 60_000;
const HOUR = 60 * MIN;

describe("WebhookDispatcher", () => {
  it("webhook retried with backoff and signed", async () => {
    const w = webhooksWorld();
    const ep = await endpoint(w);
    await w.listener.enqueue({ workspaceId: WS, type: "contact.created", entityId: "c1" });
    w.transport.statuses.push(500, 500, 200);
    const d = w.dispatcher();
    const times: number[] = [];
    const orig = w.transport.request;
    w.transport.request = async (req) => {
      times.push(w.clock.get().getTime());
      return orig(req);
    };

    expect(await d.tick()).toBe(1); // attempt 1 at T
    w.clock.advance(MIN - 1000);
    expect(await d.tick()).toBe(0); // not due yet
    w.clock.set(new Date(T0.getTime() + MIN));
    expect(await d.tick()).toBe(1); // attempt 2 at T + 1 min
    w.clock.set(new Date(T0.getTime() + MIN + 5 * MIN - 1000));
    expect(await d.tick()).toBe(0);
    w.clock.set(new Date(T0.getTime() + MIN + 5 * MIN));
    expect(await d.tick()).toBe(1); // attempt 3 at T + 1 min + 5 min

    expect(times).toEqual([T0.getTime(), T0.getTime() + MIN, T0.getTime() + 6 * MIN]);
    const row = w.db.webhookDelivery[0];
    expect(row).toMatchObject({ status: "delivered", attempts: 3, responseCode: 200, lastError: null });
    expect(row.deliveredAt).toEqual(w.clock.get());

    const ids = w.transport.calls.map((c) => headerOf(c, "x-crm-event-id"));
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe(row.payload.id);
    expect(w.transport.calls.map((c) => headerOf(c, "x-crm-delivery-attempt"))).toEqual(["1", "2", "3"]);
    for (const [i, c] of w.transport.calls.entries()) {
      expect(c.pinned).toEqual({ address: PUBLIC_IP, family: 4 });
      expect(headerOf(c, "x-crm-event")).toBe("contact.created");
      expect(headerOf(c, "user-agent")).toBe("AramCRM-Webhooks/1");
      const sig = headerOf(c, "x-crm-signature");
      expect(sig).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
      const at = [T0.getTime(), T0.getTime() + MIN, T0.getTime() + 6 * MIN][i] / 1000;
      expect(verify(ep.secret, sig, c.body, at)).toBe(true);
      expect(verify("whsec_wrong", sig, c.body, at)).toBe(false);
      const changed = c.body.replace('"Sara Ali"', '"Sara Alj"');
      expect(changed).not.toBe(c.body);
      expect(verify(ep.secret, sig, changed, at)).toBe(false);
      // Replay window: the same signature is refused 6 minutes later.
      expect(verify(ep.secret, sig, c.body, at + 360)).toBe(false);
    }
    // No response body is stored anywhere.
    expect(Object.keys(row)).not.toContain("responseBody");

    // After 6 failures the row is failed and there is no 7th attempt.
    const w2 = webhooksWorld();
    await endpoint(w2);
    await w2.listener.enqueue({ workspaceId: WS, type: "contact.created", entityId: "c1" });
    w2.transport.statuses.push(...Array(10).fill(500));
    const d2 = w2.dispatcher();
    for (let i = 0; i < 9; i++) {
      await d2.tick();
      w2.clock.advance(9 * HOUR);
    }
    expect(w2.transport.calls).toHaveLength(WEBHOOK_MAX_ATTEMPTS);
    expect(w2.db.webhookDelivery[0]).toMatchObject({ status: "failed", attempts: 6, responseCode: 500, lastError: "http_500" });
    expect(WEBHOOK_BACKOFF_MS).toEqual([60e3, 300e3, 1800e3, 7200e3, 28800e3]);
  });

  it("two dispatchers never send the same attempt", async () => {
    const w = webhooksWorld();
    await endpoint(w);
    await w.listener.enqueue({ workspaceId: WS, type: "contact.created", entityId: "c1" });
    let open!: () => void;
    w.transport.gate = new Promise<void>((r) => (open = r));
    const a = w.dispatcher();
    const b = w.dispatcher();
    const both = Promise.all([a.tick(), b.tick()]);
    await new Promise((r) => setImmediate(r));
    open();
    expect((await both).reduce((x, y) => x + y, 0)).toBe(1);
    expect(w.transport.calls).toHaveLength(1);
    expect(w.db.webhookDelivery[0]).toMatchObject({ status: "delivered", attempts: 1 });
    // A delivered row is never claimed again.
    expect(await a.tick()).toBe(0);
  });

  it("endpoint disabled after 72h of failures notifies once", async () => {
    const w = webhooksWorld();
    const ep = await endpoint(w);
    for (let i = 0; i < 3; i++) await w.service.test(WS, ep.id);
    w.transport.statuses.push(...Array(20).fill(503));
    const d = w.dispatcher();
    await d.tick();
    expect(w.db.webhookEndpoint[0]).toMatchObject({ active: true, failingSince: T0 });
    w.clock.advance(72 * HOUR - MIN);
    await d.tick();
    expect(w.db.webhookEndpoint[0].active).toBe(true);
    // The next attempts (5 min later) are past 72 h of continuous failure.
    w.clock.advance(5 * MIN);
    await d.tick();
    expect(w.db.webhookEndpoint[0]).toMatchObject({ active: false, disabledReason: "failing" });
    expect(w.notifications.notify).toHaveBeenCalledTimes(1);
    const [ws, ids, n] = w.notifications.notify.mock.calls[0] as any[];
    expect(ws).toBe(WS);
    expect([...ids].sort()).toEqual([U.admin, U.owner].sort());
    expect(n).toMatchObject({ type: "connector_needs_attention", title: "webhooks.endpoint_disabled" });
    expect(JSON.parse(n.body)).toEqual({ endpointId: ep.id, url: "https://hooks.example.com/in", reason: "failing" });
    // Later ticks: the remaining rows close as endpoint_disabled, nothing is sent, no second notification.
    const sent = w.transport.calls.length;
    w.clock.advance(9 * HOUR);
    await d.tick();
    expect(w.transport.calls).toHaveLength(sent);
    expect(w.db.webhookDelivery.every((r: any) => r.status === "failed")).toBe(true);
    expect(w.notifications.notify).toHaveBeenCalledTimes(1);
    // A success clears the failure clock; re-enabling resets it too.
    await w.service.update(WS, { userId: U.owner }, ep.id, { active: true });
    expect(w.db.webhookEndpoint[0]).toMatchObject({ active: true, disabledReason: null, failingSince: null });
  });

  it("unsafe url at send time disables immediately", async () => {
    const w = webhooksWorld();
    const ep = await endpoint(w);
    await w.service.test(WS, ep.id);
    w.transport.dns["hooks.example.com"] = ["10.0.0.7"]; // re-pointed after creation
    await w.dispatcher().tick();
    expect(w.transport.calls).toHaveLength(0);
    expect(w.db.webhookEndpoint[0]).toMatchObject({ active: false, disabledReason: "unsafe_url" });
    expect(w.db.webhookDelivery[0]).toMatchObject({ status: "failed", lastError: "unsafe_url" });
    expect(w.notifications.notify).toHaveBeenCalledTimes(1);
  });

  it("rotation signs with both secrets for 24h", async () => {
    const w = webhooksWorld();
    const ep = await endpoint(w);
    const { secret: fresh } = await w.service.rotateSecret(WS, { userId: U.owner }, ep.id);
    expect(fresh).not.toBe(ep.secret);
    expect((await w.service.list(WS)).items[0].hasPreviousSecret).toBe(true);
    const d = w.dispatcher();
    w.clock.advance(HOUR);
    await w.service.test(WS, ep.id);
    await d.tick();
    const first = w.transport.calls[0];
    const sig1 = headerOf(first, "x-crm-signature")!;
    expect(sig1.match(/v1=/g)).toHaveLength(2);
    const at1 = w.clock.get().getTime() / 1000;
    expect(verify(fresh, sig1, first.body, at1)).toBe(true);
    expect(verify(ep.secret, sig1, first.body, at1)).toBe(true);

    w.clock.advance(24 * HOUR);
    await w.service.test(WS, ep.id);
    await d.tick();
    const second = w.transport.calls[1];
    const sig2 = headerOf(second, "x-crm-signature")!;
    expect(sig2.match(/v1=/g)).toHaveLength(1);
    const at2 = w.clock.get().getTime() / 1000;
    expect(verify(fresh, sig2, second.body, at2)).toBe(true);
    expect(verify(ep.secret, sig2, second.body, at2)).toBe(false);
    expect((await w.service.list(WS)).items[0].hasPreviousSecret).toBe(false);
  });

  it("a payment-locked workspace's rows wait untouched", async () => {
    const w = webhooksWorld();
    const ep = await endpoint(w);
    await w.service.test(WS, ep.id);
    const { WebhookDispatcher } = await import("./webhook-dispatcher");
    const d = new WebhookDispatcher(w.prisma, { isLocked: async () => true } as never, w.permissions, w.notifications as never);
    d.now = w.clock.get;
    d.transport = fakeTransport();
    expect(await d.tick()).toBe(0);
    expect(w.db.webhookDelivery[0]).toMatchObject({ status: "pending", attempts: 0, leaseUntil: null });
  });
});
