import { CampaignSendService } from "./campaign-send.service";
import { makeFakePrisma } from "../channels/test-prisma";

const ch = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  workspaceId: "ws1",
  kind: "whatsapp",
  provider: "zernio",
  externalId: `acc-${id}`,
  displayName: id,
  status: "active",
  isDefault: false,
  integrationId: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  ...over,
});

describe("campaign senderChannelId must be an active zernio whatsapp channel", () => {
  const build = (senderChannelId: string | null) => {
    const prisma = makeFakePrisma({
      workspace: [{ id: "ws1", zernioProfileId: "prof1" }],
      channel: [
        ch("A", { isDefault: true }),
        ch("B"),
        ch("OFF", { status: "disconnected" }),
        ch("META", { provider: "meta", externalId: "pn" }),
        ch("FB", { kind: "facebook" }),
        ch("FOREIGN", { workspaceId: "ws2" }),
      ],
      campaign: [{ id: "camp", workspaceId: "ws1", name: "Eid", status: "draft", segmentId: null, templateId: "tpl", zernioBroadcastId: null, senderChannelId }],
      template: [{ id: "tpl", workspaceId: "ws1", name: "eid", lang: "ar", status: "approved", body: "Hi" }],
      contact: [{ id: "c", workspaceId: "ws1", name: "C", phone: "+962790000000", lifecycle: "lead" }],
    });
    const zernio = {
      bulkCreateContacts: jest.fn(async () => ({})),
      createWhatsAppBroadcast: jest.fn(async () => "b1"),
      addBroadcastRecipients: jest.fn(async () => ({})),
      sendBroadcast: jest.fn(async () => {}),
    };
    const svc = new CampaignSendService(prisma, zernio as never, { isLocked: async () => false } as never);
    return { svc, zernio, prisma };
  };

  it("sends from the chosen channel's account", async () => {
    const { svc, zernio } = build("B");
    await svc.launch("ws1", "camp", { mode: "now", variables: [] });
    expect(zernio.createWhatsAppBroadcast).toHaveBeenCalledWith(expect.objectContaining({ accountId: "acc-B" }));
  });

  it("null falls back to the default Zernio WhatsApp channel", async () => {
    const { svc, zernio } = build(null);
    await svc.launch("ws1", "camp", { mode: "now", variables: [] });
    expect(zernio.createWhatsAppBroadcast).toHaveBeenCalledWith(expect.objectContaining({ accountId: "acc-A" }));
  });

  it.each(["OFF", "META", "FB", "FOREIGN", "missing"])("rejects %s with 400 channels.sender_invalid", async (id) => {
    const { svc, zernio } = build(id);
    await expect(svc.launch("ws1", "camp", { mode: "now", variables: [] })).rejects.toMatchObject({
      status: 400,
      response: { message: "channels.sender_invalid" },
    });
    expect(zernio.createWhatsAppBroadcast).not.toHaveBeenCalled();
  });

  it("validateSender guards create/update too", async () => {
    const { svc } = build(null);
    await expect(svc.validateSender("ws1", "B")).resolves.toBeUndefined();
    await expect(svc.validateSender("ws1", null)).resolves.toBeUndefined();
    await expect(svc.validateSender("ws1", "META")).rejects.toMatchObject({ response: { message: "channels.sender_invalid" } });
  });
});
