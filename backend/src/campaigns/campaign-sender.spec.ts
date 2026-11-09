import { CampaignSendService } from "./campaign-send.service";
import { makeFakePrisma } from "../channels/test-prisma";
import { campaignSenderOptions, campaignSenders } from "../channels/default-channel";

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

  it("create/update guard: campaignSenders (validateSender was removed in SP-13 fix round 1)", async () => {
    const { prisma } = build(null);
    await expect(campaignSenders(prisma, "ws1", ["B"])).resolves.toHaveLength(1);
    await expect(campaignSenders(prisma, "ws1", [])).resolves.toEqual([]);
    await expect(campaignSenders(prisma, "ws1", ["META"])).rejects.toMatchObject({ response: { message: "channels.sender_invalid" } });
  });
});

describe("SP-13 campaign senders", () => {
  const build = (plan = "pro", extra: Record<string, unknown>[] = []) =>
    makeFakePrisma({
      workspace: [{ id: "ws1", plan, zernioProfileId: "prof1" }],
      channel: [
        ch("A", { isDefault: true, phoneNumber: "+962790000001", displayName: "Main" }),
        ch("B", { phoneNumber: "+962790000002" }),
        ch("C"),
        ch("OFF", { status: "disconnected" }),
        ch("PEND", { status: "needs_attention" }),
        ch("META", { provider: "meta", externalId: "pn" }),
        ch("FB", { kind: "facebook" }),
        ch("FOREIGN", { workspaceId: "ws2" }),
        ...extra,
      ],
    });
  const err = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return { status: (e as { getStatus(): number }).getStatus(), ...(e as { getResponse(): object }).getResponse() };
    }
    return null;
  };

  it("campaignSenders validates every sender and caps at the plan limit", async () => {
    const prisma = build();
    // Order kept, duplicates removed (first kept), one query for all ids.
    await expect(campaignSenders(prisma, "ws1", ["B", "A", "B"])).resolves.toEqual([
      { channelId: "B", accountId: "acc-B", displayName: "B", phoneNumber: "+962790000002" },
      { channelId: "A", accountId: "acc-A", displayName: "Main", phoneNumber: "+962790000001" },
    ]);
    expect(prisma.channel.findMany).toHaveBeenCalledTimes(1);
    await expect(campaignSenders(prisma, "ws1", [])).resolves.toEqual([]);
    // A foreign id answers exactly like a missing one; a Meta number is refused.
    for (const bad of ["FOREIGN", "missing", "META", "OFF", "PEND", "FB"]) {
      expect(await err(campaignSenders(prisma, "ws1", ["A", bad]))).toEqual({
        status: 400,
        statusCode: 400,
        message: "channels.sender_invalid",
        channelId: bad,
      });
    }
    // growth allows 3 numbers: 3 pass, limit + 1 is refused before any lookup.
    const growth = build("growth", [ch("D")]);
    await expect(campaignSenders(growth, "ws1", ["A", "B", "C"])).resolves.toHaveLength(3);
    growth.channel.findMany.mockClear();
    expect(await err(campaignSenders(growth, "ws1", ["A", "B", "C", "D"]))).toEqual({
      status: 400,
      statusCode: 400,
      message: "campaigns.too_many_senders",
      limit: 3,
    });
    expect(growth.channel.findMany).not.toHaveBeenCalled();
    // Duplicates do not count toward the limit.
    await expect(campaignSenders(growth, "ws1", ["A", "B", "C", "A"])).resolves.toHaveLength(3);
    // Never more than 10, whatever the plan.
    const many = Array.from({ length: 11 }, (_, i) => ch(`M${i}`));
    const big = build("pro", many);
    const prev = process.env.CHANNEL_WHATSAPP_LIMIT;
    process.env.CHANNEL_WHATSAPP_LIMIT = "50";
    try {
      expect(await err(campaignSenders(big, "ws1", many.map((m) => m.id)))).toMatchObject({ message: "campaigns.too_many_senders", limit: 10 });
    } finally {
      if (prev === undefined) delete process.env.CHANNEL_WHATSAPP_LIMIT;
      else process.env.CHANNEL_WHATSAPP_LIMIT = prev;
    }
  });

  it("campaignSenderOptions lists WhatsApp numbers with eligibility (GET /campaigns/senders)", async () => {
    const prisma = build("growth");
    const r = await campaignSenderOptions(prisma, "ws1");
    expect(r.connected).toBe(true);
    expect(r.limit).toBe(3);
    expect(r.senders.map((s) => [s.channelId, s.eligible, s.reason, s.isDefault])).toEqual([
      ["A", true, null, true],
      ["B", true, null, false],
      ["C", true, null, false],
      ["PEND", false, "not_active", false],
      ["META", false, "provider_meta", false],
    ]);
    expect(r.senders[0]).toEqual({
      channelId: "A",
      displayName: "Main",
      phoneNumber: "+962790000001",
      isDefault: true,
      provider: "zernio",
      eligible: true,
      reason: null,
    });
    // No eligible number, or no Zernio profile: not connected.
    const none = makeFakePrisma({ workspace: [{ id: "ws1", plan: "free", zernioProfileId: "p" }], channel: [ch("META", { provider: "meta" })] });
    expect((await campaignSenderOptions(none, "ws1")).connected).toBe(false);
    const noProfile = makeFakePrisma({ workspace: [{ id: "ws1", plan: "free", zernioProfileId: null }], channel: [ch("A")] });
    expect((await campaignSenderOptions(noProfile, "ws1")).connected).toBe(false);
  });
});
