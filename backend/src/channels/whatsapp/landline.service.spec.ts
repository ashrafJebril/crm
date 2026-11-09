import { makeFakePrisma } from "../test-prisma";
import { channelErrorKey } from "../channel-errors";
import { ChannelTransportRegistry } from "../channel-transport";
import { MetaGraphClient } from "./meta-graph.client";
import { LandlineService } from "./landline.service";
import { fakeGraph, graphError, isolateEnv, type GraphHandler } from "./test-graph";

const LTOKEN = "LANDLINE-TOKEN-0123456789";

const pending = (over: Record<string, unknown> = {}) => ({
  id: "P",
  workspaceId: "ws1",
  kind: "whatsapp",
  provider: "meta",
  externalId: null,
  displayName: "WhatsApp",
  phoneNumber: null,
  status: "pending",
  isDefault: false,
  integrationId: null,
  config: { wabaId: "waba-L", verification: { stage: "needs_number" } },
  secretsEnc: JSON.stringify({ accessToken: LTOKEN }),
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  ...over,
});

const ok = (): GraphHandler[] => [
  ["POST https://graph.facebook.com/v21.0/waba-L/phone_numbers", { body: { id: "pn-L" } }],
  ["POST https://graph.facebook.com/v21.0/pn-L/request_code", { body: { success: true } }],
  ["POST https://graph.facebook.com/v21.0/pn-L/verify_code", { body: { success: true } }],
  ["POST https://graph.facebook.com/v21.0/pn-L/register", { body: { success: true } }],
  ["POST https://graph.facebook.com/v21.0/waba-L/subscribed_apps", { body: { success: true } }],
  [/GET \S+\/pn-L\?fields=/, { body: { id: "pn-L" } }],
];

function build(rows: Record<string, unknown>[] = [pending()], handlers: GraphHandler[] = ok()) {
  const prisma = makeFakePrisma({ channel: rows, workspace: [{ id: "ws1", plan: "growth" }] } as never);
  prisma.raw = prisma;
  const g = fakeGraph(handlers);
  const realtime = { emitToWorkspace: jest.fn() };
  const transports = new ChannelTransportRegistry();
  const svc = new LandlineService(prisma, new MetaGraphClient(g.fetch), realtime as never, transports);
  svc.onModuleInit();
  return { prisma, g, realtime, svc, transports, row: () => prisma.db.channel.find((c: { id: string }) => c.id === "P") };
}

const key = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (x) => x,
  );
  return e ? { key: channelErrorKey(e), status: e.getStatus?.(), body: e.getResponse?.() } : null;
};

describe("landline verification", () => {
  let restore: () => void;
  let now = Date.parse("2026-11-09T10:00:00Z");
  beforeEach(() => {
    restore = isolateEnv();
    now = Date.parse("2026-11-09T10:00:00Z");
    jest.spyOn(Date, "now").mockImplementation(() => now);
  });
  afterEach(() => {
    restore();
    jest.restoreAllMocks();
  });

  it("landline happy path reaches active", async () => {
    const { svc, g, row, realtime } = build();

    const a = await svc.addNumber("ws1", "P", { cc: "+962", phoneNumber: "06 500 0000", verifiedName: "Shop L" });
    expect(a).toMatchObject({ externalId: "pn-L", phoneNumber: "+96265000000", displayName: "Shop L", status: "pending", config: { verification: { stage: "awaiting_code" } } });
    expect(g.calls[0].body).toEqual({ cc: "962", phone_number: "065000000", verified_name: "Shop L" });
    expect(g.calls[0].headers.Authorization).toBe(`Bearer ${LTOKEN}`);

    const r = await svc.requestCode("ws1", "P", { method: "VOICE", language: "ar" });
    expect(g.calls[1].body).toEqual({ code_method: "VOICE", language: "ar" });
    expect(r.config).toMatchObject({ verification: { stage: "awaiting_code", resendAt: new Date(now + 60_000).toISOString() } });

    const v = await svc.verify("ws1", "P", { code: "123456" });
    expect(g.calls[2].body).toEqual({ code: "123456" });
    expect(v.config).toMatchObject({ verification: { stage: "needs_registration" } });

    const done = await svc.register("ws1", "P");
    const pin = JSON.parse(row().secretsEnc).registrationPin;
    expect(pin).toMatch(/^\d{6}$/);
    expect(g.calls[3]).toMatchObject({ url: "https://graph.facebook.com/v21.0/pn-L/register", body: { messaging_product: "whatsapp", pin } });
    expect(g.calls[4].url).toBe("https://graph.facebook.com/v21.0/waba-L/subscribed_apps");
    expect(done).toMatchObject({ status: "active", statusReason: null, isDefault: true, config: { wabaId: "waba-L" } });
    expect(done.config).not.toHaveProperty("verification");
    expect(JSON.parse(row().secretsEnc).accessToken).toBe(LTOKEN);
    expect(realtime.emitToWorkspace).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(done)).not.toContain(LTOKEN);
    expect(JSON.stringify(done)).not.toContain(pin);
  });

  it("landline wrong code and cooldown map to keys", async () => {
    const { svc, g, row } = build([pending({ externalId: "pn-L", config: { wabaId: "waba-L", verification: { stage: "awaiting_code" } } })]);

    // cooldown: a second request inside 60 s is refused before Meta is asked
    await svc.requestCode("ws1", "P", { method: "SMS", language: "en_US" });
    now += 30_000;
    expect(await key(svc.requestCode("ws1", "P", { method: "SMS", language: "en_US" }))).toEqual({
      key: "channels.landline_cooldown",
      status: 429,
      body: expect.objectContaining({ retryAfter: 30, resendAt: new Date(now + 30_000).toISOString() }),
    });
    expect(g.called("/request_code")).toHaveLength(1);
    now += 31_000;
    await svc.requestCode("ws1", "P", { method: "VOICE", language: "en_US" });
    expect(g.called("/request_code")).toHaveLength(2);

    // Meta's wrong-code error
    g.prepend(["/verify_code", graphError(136025, "Verify code error")]);
    expect(await key(svc.verify("ws1", "P", { code: "000000" }))).toMatchObject({ key: "channels.landline_wrong_code", status: 400, body: expect.objectContaining({ metaCode: 136025 }) });
    expect(row().config.verification.stage).toBe("awaiting_code");

    // malformed code: never sent to Meta
    const before = g.calls.length;
    expect(await key(svc.verify("ws1", "P", { code: "12a" }))).toMatchObject({ key: "channels.landline_invalid_input", status: 400, body: expect.objectContaining({ field: "code" }) });
    expect(g.calls.length).toBe(before);

    // Meta throttling
    now += 61_000;
    g.prepend(["/request_code", graphError(133016, "Too many attempts")]);
    expect(await key(svc.requestCode("ws1", "P", { method: "SMS", language: "en_US" }))).toMatchObject({ key: "channels.landline_rate_limited", status: 429 });
  });

  it("a call in the wrong stage is 409 channels.landline_wrong_state", async () => {
    const { svc, g } = build();
    expect(await key(svc.verify("ws1", "P", { code: "123456" }))).toMatchObject({ key: "channels.landline_wrong_state", status: 409, body: expect.objectContaining({ stage: "needs_number" }) });
    expect(await key(svc.requestCode("ws1", "P", { method: "SMS", language: "en_US" }))).toMatchObject({ key: "channels.landline_wrong_state" });
    expect(await key(svc.register("ws1", "P"))).toMatchObject({ key: "channels.landline_wrong_state" });
    expect(g.fetch).not.toHaveBeenCalled();
  });

  it("an active channel, a channel of another kind and a disconnected one are in the wrong state", async () => {
    const { svc } = build([
      pending({ id: "A", status: "active", config: { wabaId: "w" } }),
      pending({ id: "T", kind: "telegram", provider: "telegram" }),
      pending({ id: "D", status: "disconnected" }),
    ]);
    for (const id of ["A", "T", "D"]) {
      expect(await key(svc.addNumber("ws1", id, { cc: "1", phoneNumber: "5550100", verifiedName: "x" }))).toMatchObject({ key: "channels.landline_wrong_state" });
    }
  });

  it("a foreign channel id is 404 channels.not_found", async () => {
    const { svc, g } = build([pending({ workspaceId: "ws2" })]);
    expect(await key(svc.addNumber("ws1", "P", { cc: "1", phoneNumber: "5550100", verifiedName: "x" }))).toMatchObject({ key: "channels.not_found", status: 404 });
    expect(await key(svc.register("ws1", "P"))).toMatchObject({ key: "channels.not_found" });
    expect(g.fetch).not.toHaveBeenCalled();
  });

  it("invalid number input is rejected per field before Meta is called", async () => {
    const { svc, g } = build();
    for (const [input, field] of [
      [{ cc: "abc", phoneNumber: "5550100", verifiedName: "x" }, "cc"],
      [{ cc: "1", phoneNumber: "12", verifiedName: "x" }, "phoneNumber"],
      [{ cc: "1", phoneNumber: "5550100", verifiedName: "  " }, "verifiedName"],
    ] as const) {
      expect(await key(svc.addNumber("ws1", "P", input))).toMatchObject({ key: "channels.landline_invalid_input", body: expect.objectContaining({ field }) });
    }
    expect(await key(svc.requestCode("ws1", "P", { method: "FAX" as never, language: "en_US" }))).toMatchObject({ key: "channels.landline_invalid_input" });
    expect(g.fetch).not.toHaveBeenCalled();
  });

  it("a number already on the WABA is adopted; one that is not found is channels.landline_number_in_use", async () => {
    const { svc, g } = build();
    g.prepend(
      ["POST https://graph.facebook.com/v21.0/waba-L/phone_numbers", graphError(2388012, "already exists")],
      ["GET https://graph.facebook.com/v21.0/waba-L/phone_numbers", { body: { data: [{ id: "pn-old", display_phone_number: "+962 6 500 0000" }] } }],
    );
    const dto = await svc.addNumber("ws1", "P", { cc: "962", phoneNumber: "065000000", verifiedName: "Shop" });
    expect(dto).toMatchObject({ externalId: "pn-old", config: { verification: { stage: "awaiting_code" } } });

    const other = build();
    other.g.prepend(
      ["POST https://graph.facebook.com/v21.0/waba-L/phone_numbers", graphError(2388012, "already exists")],
      ["GET https://graph.facebook.com/v21.0/waba-L/phone_numbers", { body: { data: [{ id: "x", display_phone_number: "+1 555 0100" }] } }],
    );
    expect(await key(other.svc.addNumber("ws1", "P", { cc: "962", phoneNumber: "065000000", verifiedName: "Shop" }))).toMatchObject({
      key: "channels.landline_number_in_use",
      status: 400,
    });
  });

  it("a number another channel of this workspace already holds is 409 channels.already_connected", async () => {
    const { svc } = build([pending(), pending({ id: "B", externalId: "pn-L", status: "active", config: { wabaId: "waba-L" } })]);
    expect(await key(svc.addNumber("ws1", "P", { cc: "962", phoneNumber: "65000000", verifiedName: "Shop" }))).toMatchObject({ key: "channels.already_connected" });
  });

  it("an unclassified Meta error is 502 channels.landline_meta_error with its code only", async () => {
    const { svc, g } = build();
    g.prepend(["/phone_numbers", graphError(131000, `Something went wrong ${LTOKEN}`, 500)]);
    const r = await key(svc.addNumber("ws1", "P", { cc: "962", phoneNumber: "65000000", verifiedName: "Shop" }));
    expect(r).toMatchObject({ key: "channels.landline_meta_error", status: 502, body: expect.objectContaining({ metaCode: 131000 }) });
    expect(JSON.stringify(r)).not.toContain(LTOKEN);
  });

  it("a refused register keeps needs_registration and the PIN, so the retry uses the same PIN", async () => {
    const { svc, g, row } = build([pending({ externalId: "pn-L", config: { wabaId: "waba-L", verification: { stage: "needs_registration" } } })]);
    g.prepend(["/pn-L/register", graphError(133016, "Too many register attempts")]);
    expect(await key(svc.register("ws1", "P"))).toMatchObject({ key: "channels.landline_rate_limited", status: 429 });
    expect(row()).toMatchObject({ status: "pending", statusReason: "meta_register_failed", config: { verification: { stage: "needs_registration" } } });
    const pin = JSON.parse(row().secretsEnc).registrationPin;
    g.prepend(["/pn-L/register", { body: { success: true } }]);
    expect(await svc.register("ws1", "P")).toMatchObject({ status: "active" });
    expect(g.called("/register").map((c) => c.body.pin)).toEqual([pin, pin]);
  });
});

describe("Meta reconnect hook (POST /channels/:id/reconnect)", () => {
  let restore: () => void;
  beforeEach(() => (restore = isolateEnv()));
  afterEach(() => {
    restore();
    jest.restoreAllMocks();
  });

  const live = (over: Record<string, unknown> = {}) =>
    pending({ externalId: "pn-L", status: "error", statusReason: "meta_subscribe_failed", config: { wabaId: "waba-L" }, ...over });

  it("registers a meta transport whose reconnect re-subscribes the WABA and reactivates", async () => {
    const { transports, g, row } = build([live()]);
    const t = transports.get("meta")!;
    expect(t).toBeDefined();
    const out = await t.reconnect!(row());
    expect(out).toMatchObject({ status: "active", statusReason: null, disconnectedAt: null });
    expect(g.called("/subscribed_apps")).toHaveLength(1);
    // Meta conversations keep their dedicated send route
    await expect(t.sendText(row(), {} as never, "x")).rejects.toMatchObject({ response: { message: "channels.transport_unavailable", provider: "meta" } });
  });

  it("a pending row needing registration is registered by the reconnect", async () => {
    const { transports, g, row } = build([live({ status: "pending", config: { wabaId: "waba-L", verification: { stage: "needs_registration" } } })]);
    const out = await transports.get("meta")!.reconnect!(row());
    expect(out.status).toBe("active");
    expect(g.called("/register")).toHaveLength(1);
  });

  it("a row still waiting for its number or code is 409 channels.landline_wrong_state", async () => {
    const { transports, row, g } = build([pending()]);
    expect(await key(transports.get("meta")!.reconnect!(row()))).toMatchObject({ key: "channels.landline_wrong_state" });
    expect(g.fetch).not.toHaveBeenCalled();
  });

  it("a revoked token is 400 channels.meta_token_invalid and the row is untouched", async () => {
    const { transports, g, row } = build([live()]);
    g.prepend([/GET \S+\/pn-L\?fields=/, graphError(190, "Error validating access token")]);
    const before = { ...row() };
    expect(await key(transports.get("meta")!.reconnect!(row()))).toMatchObject({ key: "channels.meta_token_invalid", status: 400 });
    expect(row()).toEqual(before);
  });

  it("reviving a disconnected number needs a free slot", async () => {
    const { transports, prisma, row } = build([live({ status: "disconnected", statusReason: "disconnected_by_user" })]);
    prisma.db.workspace[0].plan = "free";
    prisma.db.channel.push(pending({ id: "other", externalId: "pn-X", status: "active", config: {} }));
    expect(await key(transports.get("meta")!.reconnect!(row()))).toMatchObject({ key: "channels.limit_reached", status: 409 });
  });
});
