import { ROUTE_PERMISSIONS, routesOf } from "../../permissions/permission-map";
import { WhatsappChannelsController } from "./whatsapp-channels.controller";
import { isolateEnv, META_ENV } from "./test-graph";

function build(canUpdate = false) {
  const signup = { signup: jest.fn(async () => ({ id: "ch-B" })) };
  const landline = {
    addNumber: jest.fn(async () => ({ id: "P" })),
    requestCode: jest.fn(async () => ({ id: "P" })),
    verify: jest.fn(async () => ({ id: "P" })),
    register: jest.fn(async () => ({ id: "P" })),
  };
  const wa = {
    connectByToken: jest.fn(async () => ({
      connected: true,
      channelId: "ch-M",
      webhookSubscribed: true,
      verifyToken: "should-not-leak",
      discovered: { wabas: [{ id: "w", name: "W", phones: [] }], picked: { wabaId: "w", phoneNumberId: "pn" } },
    })),
  };
  const channels = { get: jest.fn(async (_ws: string, id: string) => ({ id, kind: "whatsapp" })) };
  const perm = { viewerCan: jest.fn(async () => canUpdate) };
  const ctrl = new WhatsappChannelsController(signup as never, landline as never, wa as never, channels as never, perm as never);
  return { ctrl, signup, landline, wa, channels, perm };
}

describe("WhatsappChannelsController", () => {
  let restore: () => void;
  beforeEach(() => (restore = isolateEnv({ META_APP_SECRET_WA: META_ENV.META_APP_SECRET_WA })));
  afterEach(() => restore());

  it("config: env names only for channels.update holders, never the secret", async () => {
    const viewer = { userId: "u" } as never;
    const agent = await build(false).ctrl.config("ws1", viewer);
    expect(agent).toEqual({ enabled: false, graphVersion: "v21.0", reason: "channels.embedded_signup_not_configured" });
    const { ctrl, perm } = build(true);
    const owner = await ctrl.config("ws1", viewer);
    expect(owner.missing).toEqual(["META_APP_ID_WA", "META_WA_CONFIG_ID"]);
    expect(perm.viewerCan).toHaveBeenCalledWith("ws1", viewer, "channels.update");
    expect(JSON.stringify(owner)).not.toContain(META_ENV.META_APP_SECRET_WA);
  });

  it("signup and landline routes delegate with the workspace from the request", async () => {
    const { ctrl, signup, landline } = build();
    await ctrl.signup("ws1", { code: "c", wabaId: "1", phoneNumberId: "2", signupEvent: "FINISH" });
    expect(signup.signup).toHaveBeenCalledWith("ws1", { code: "c", wabaId: "1", phoneNumberId: "2", signupEvent: "FINISH" });
    await ctrl.landlineNumber("ws1", "P", { cc: "1", phoneNumber: "5550100", verifiedName: "x" });
    await ctrl.landlineRequestCode("ws1", "P", { method: "SMS", language: "en_US" });
    await ctrl.landlineVerify("ws1", "P", { code: "123456" });
    await ctrl.landlineRegister("ws1", "P");
    expect(landline.addNumber).toHaveBeenCalledWith("ws1", "P", { cc: "1", phoneNumber: "5550100", verifiedName: "x" });
    expect(landline.requestCode).toHaveBeenCalledWith("ws1", "P", { method: "SMS", language: "en_US" });
    expect(landline.verify).toHaveBeenCalledWith("ws1", "P", { code: "123456" });
    expect(landline.register).toHaveBeenCalledWith("ws1", "P");
  });

  it("manual connect returns the new channel's DTO and never the token or the verify token", async () => {
    const { ctrl, wa, channels } = build();
    const out = await ctrl.manual("ws1", { accessToken: "SECRET-TOKEN-1234567890", phoneNumberId: "pn" });
    expect(wa.connectByToken).toHaveBeenCalledWith("ws1", "SECRET-TOKEN-1234567890", { phoneNumberId: "pn", errorStyle: "keys", add: true });
    expect(channels.get).toHaveBeenCalledWith("ws1", "ch-M");
    expect(out).toEqual({
      channel: { id: "ch-M", kind: "whatsapp" },
      webhookSubscribed: true,
      discovered: { wabas: [{ id: "w", name: "W", phones: [] }], picked: { wabaId: "w", phoneNumberId: "pn" } },
    });
    const json = JSON.stringify(out);
    expect(json).not.toContain("SECRET-TOKEN");
    expect(json).not.toContain("should-not-leak");
  });

  it("every route is in permission-map.ts with the plan's permission", () => {
    const keys = routesOf(WhatsappChannelsController).map((r) => r.key).sort();
    expect(keys).toEqual(
      [
        "GET /channels/whatsapp/embedded-signup/config",
        "POST /channels/whatsapp/embedded-signup",
        "POST /channels/whatsapp/manual",
        "POST /channels/:id/landline/number",
        "POST /channels/:id/landline/request-code",
        "POST /channels/:id/landline/verify",
        "POST /channels/:id/landline/register",
      ].sort(),
    );
    expect(Object.fromEntries(keys.map((k) => [k, ROUTE_PERMISSIONS[k]]))).toEqual({
      "GET /channels/whatsapp/embedded-signup/config": "channels.view",
      "POST /channels/whatsapp/embedded-signup": "channels.create",
      "POST /channels/whatsapp/manual": "channels.create",
      "POST /channels/:id/landline/number": "channels.update",
      "POST /channels/:id/landline/request-code": "channels.update",
      "POST /channels/:id/landline/verify": "channels.update",
      "POST /channels/:id/landline/register": "channels.update",
    });
  });
});
