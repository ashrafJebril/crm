import { WhatsAppService } from "./whatsapp.service";
import { WhatsAppController } from "./whatsapp.controller";
import { makeFakePrisma } from "../channels/test-prisma";

const integration = {
  id: "int",
  workspaceId: "ws1",
  platform: "whatsapp",
  provider: "meta",
  pageId: "pn-1",
  pageName: "+962 79",
  accessToken: "tok",
  raw: JSON.stringify({ wabaId: "waba", verifyToken: "aram-wa-secret1" }),
  createdAt: new Date(),
};

function build() {
  const prisma = makeFakePrisma({ integration: [{ ...integration }] });
  const svc = new WhatsAppService(prisma, {} as never, {} as never, {} as never, {} as never);
  return { prisma, svc };
}

describe("GET /integrations/whatsapp/status drops verifyToken for non-channels.update callers (R10)", () => {
  it("the service only includes it when asked", async () => {
    const { svc } = build();
    expect(await svc.status("ws1")).not.toHaveProperty("verifyToken");
    expect(await svc.status("ws1", { includeVerifyToken: true })).toMatchObject({ verifyToken: "aram-wa-secret1" });
  });

  it("the controller asks only for channels.update holders", async () => {
    const wa = { status: jest.fn(async () => ({})) };
    const perm = { viewerCan: jest.fn(async () => false) };
    const ctrl = new WhatsAppController(wa as never, {} as never, perm as never);
    await ctrl.status("ws1", { userId: "agent" } as never);
    expect(wa.status).toHaveBeenLastCalledWith("ws1", { includeVerifyToken: false });
    expect(perm.viewerCan).toHaveBeenCalledWith("ws1", { userId: "agent" }, "channels.update");
    perm.viewerCan.mockResolvedValue(true);
    await ctrl.status("ws1", { userId: "owner" } as never);
    expect(wa.status).toHaveBeenLastCalledWith("ws1", { includeVerifyToken: true });
  });
});

describe("verifyWebhook also accepts META_VERIFY_TOKEN", () => {
  const prev = process.env.META_VERIFY_TOKEN;
  afterEach(() => {
    if (prev === undefined) delete process.env.META_VERIFY_TOKEN;
    else process.env.META_VERIFY_TOKEN = prev;
  });

  it("echoes the challenge for the app-level token, still for a workspace token, and rejects others", async () => {
    process.env.META_VERIFY_TOKEN = "app-level-token";
    const { svc } = build();
    await expect(svc.verifyWebhook("subscribe", "app-level-token", "c1")).resolves.toBe("c1");
    await expect(svc.verifyWebhook("subscribe", "aram-wa-secret1", "c2")).resolves.toBe("c2");
    await expect(svc.verifyWebhook("subscribe", "nope", "c3")).rejects.toThrow(/mismatch/);
  });

  it("an unset META_VERIFY_TOKEN never matches an empty token", async () => {
    delete process.env.META_VERIFY_TOKEN;
    const { svc } = build();
    await expect(svc.verifyWebhook("subscribe", "", "c")).rejects.toThrow(/mismatch/);
  });
});

describe("legacy disconnect keeps channel state honest", () => {
  it("deleting the WhatsApp Integration marks its mirrored channel disconnected", async () => {
    const { svc, prisma } = build();
    prisma.db.channel.push({
      id: "chi_int",
      workspaceId: "ws1",
      kind: "whatsapp",
      provider: "meta",
      externalId: "pn-1",
      status: "active",
      isDefault: true,
      integrationId: "int",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    jest.spyOn(svc as unknown as { unsubscribeAppFromWaba: () => Promise<void> }, "unsubscribeAppFromWaba").mockResolvedValue();
    await svc.disconnect("ws1");
    expect(prisma.db.channel[0]).toMatchObject({ status: "disconnected", isDefault: false });
  });
});
