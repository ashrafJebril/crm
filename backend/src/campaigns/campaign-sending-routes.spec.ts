import { makeFakePrisma } from "../channels/test-prisma";
import { MediaService } from "../media/media.service";
import { TemplatesService } from "../templates/templates.service";
import { CampaignSendService } from "./campaign-send.service";
import { CampaignsController } from "./campaigns.module";
import { CampaignPreviewService } from "./sending/campaign-preview.service";

const ch = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  workspaceId: "ws1",
  kind: "whatsapp",
  provider: "zernio",
  externalId: `acc-${id}`,
  displayName: `Number ${id}`,
  phoneNumber: null,
  status: "active",
  isDefault: false,
  integrationId: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  ...over,
});

const camp = (id: string, ws: string, over: Record<string, unknown> = {}) => ({
  id,
  workspaceId: ws,
  name: id,
  status: "draft",
  audience: "All",
  channel: "Broadcast",
  segmentId: null,
  templateId: "tpl",
  zernioBroadcastId: null,
  senderChannelId: null,
  senderChannelIds: [],
  recipients: 0,
  ...over,
});

function build(opts: { profile?: string | null; channels?: Record<string, unknown>[] } = {}) {
  const prisma = makeFakePrisma({
    workspace: [
      { id: "ws1", plan: "pro", zernioProfileId: opts.profile === undefined ? "prof1" : opts.profile },
      { id: "ws2", plan: "pro", zernioProfileId: "prof2" },
    ],
    channel: opts.channels ?? [ch("A", { isDefault: true, phoneNumber: "+962790000001" }), ch("B"), ch("X", { workspaceId: "ws2" })],
    campaign: [
      camp("mine", "ws1"),
      camp("theirs", "ws2", { status: "running", zernioBroadcastId: "zb" }),
      camp("theirs-draft", "ws2"),
    ],
    template: [{ id: "tpl", workspaceId: "ws1", name: "eid", lang: "ar", status: "approved", body: "Hi" }],
    contact: [{ id: "c", workspaceId: "ws1", name: "C", phone: "+962790000009", lifecycle: "lead", marketingOptOut: false }],
    media: [
      { id: "m1", workspaceId: "ws1", mimeType: "image/png", uploadedById: "u-owner" },
      { id: "m2", workspaceId: "ws2", mimeType: "image/png", uploadedById: "u-other" },
      // An inbound customer attachment (no uploader), in no conversation the restricted agent sees.
      { id: "m-inbound", workspaceId: "ws1", mimeType: "image/jpeg", uploadedById: null },
    ],
    message: [],
  });
  const zernio = {
    whatsappTemplates: jest.fn(async () => [{ id: "t", name: "eid", language: "ar", status: "APPROVED", category: "MARKETING", components: [{ type: "BODY", text: "Hi" }] }]),
    bulkCreateContacts: jest.fn(async () => ({})),
    createWhatsAppBroadcast: jest.fn(async () => "b1"),
    addBroadcastRecipients: jest.fn(async () => ({})),
    sendBroadcast: jest.fn(async () => {}),
    cancelBroadcast: jest.fn(async () => {}),
    createWhatsAppTemplate: jest.fn(async () => ({ id: "m", status: "PENDING" })),
    updateWhatsAppTemplate: jest.fn(async () => ({ status: "PENDING" })),
    whatsappLibraryTemplate: jest.fn(async () => ({})),
  };
  const send = new CampaignSendService(prisma, zernio as never, { isLocked: async () => false } as never);
  // Assigned-only visibility for "u-restricted"; everyone else sees everything.
  const perm = {
    conversationScope: jest.fn(async (_ws: string, v?: { userId: string }) => (v?.userId === "u-restricted" ? { assigneeId: "u-restricted" } : {})),
  };
  const media = new MediaService(prisma, {} as never, perm as never);
  const previewSvc = new CampaignPreviewService(prisma, zernio as never, media);
  const ctrl = new CampaignsController(prisma, send, previewSvc, media);
  const templates = new TemplatesService(prisma, zernio as never);
  return { prisma, zernio, send, ctrl, templates };
}

const err = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return { status: (e as { getStatus(): number }).getStatus(), ...(e as { getResponse(): object }).getResponse() };
  }
  return null;
};

/** A request as PermissionGuard leaves it. */
const req = (perms: Record<string, string[]>) => ({ user: { workspaceId: "ws1" }, permissions: { permissions: perms } }) as never;

describe("SP-13 campaign routes", () => {
  it("foreign ids return 404 on SP-13 routes", async () => {
    const { ctrl, zernio } = build();
    const notFound = { status: 404, statusCode: 404, message: "campaigns.not_found" };
    expect(await err(ctrl.get("ws1", "theirs"))).toEqual(notFound);
    expect(await err(ctrl.get("ws1", "nope"))).toEqual(notFound);
    expect(await err(ctrl.update("ws1", "theirs-draft", { name: "x" }))).toEqual(notFound);
    expect(await err(ctrl.launch("ws1", "theirs-draft", { mode: "now" }))).toEqual(notFound);
    expect(await err(ctrl.cancel("ws1", "theirs"))).toEqual(notFound);
    expect(zernio.cancelBroadcast).not.toHaveBeenCalled();
    expect(zernio.createWhatsAppBroadcast).not.toHaveBeenCalled();
    // A foreign headerMediaId on PATCH (and create) is 404 too.
    expect(await err(ctrl.update("ws1", "mine", { headerMediaId: "m2" }))).toMatchObject({ status: 404 });
    expect(await err(ctrl.create("ws1", { name: "n", audience: "a", channel: "Broadcast", headerMediaId: "m2" }))).toMatchObject({
      status: 404,
    });
  });

  it("header media goes through MediaService.get with the viewer (fix M2)", async () => {
    const { ctrl } = build();
    const restricted = { userId: "u-restricted" };
    const owner = { userId: "u-owner" };
    // A library file is fine for anyone in the workspace.
    await expect(ctrl.update("ws1", "mine", { headerMediaId: "m1" }, restricted)).resolves.toMatchObject({ headerMediaId: "m1" });
    // An inbound attachment from a conversation the viewer cannot see is 404, on PATCH, create and preview.
    expect(await err(ctrl.update("ws1", "mine", { headerMediaId: "m-inbound" }, restricted))).toMatchObject({
      status: 404,
      message: "Media not found",
    });
    expect(await err(ctrl.create("ws1", { name: "n", audience: "a", channel: "Broadcast", headerMediaId: "m-inbound" }, restricted))).toMatchObject({
      status: 404,
    });
    expect(
      await err(ctrl.previewV2("ws1", { headerMediaId: "m-inbound" }, req({ campaigns: ["view"] }), restricted)),
    ).toMatchObject({ status: 404 });
    // An unrestricted member may use it.
    await expect(ctrl.update("ws1", "mine", { headerMediaId: "m-inbound" }, owner)).resolves.toMatchObject({ headerMediaId: "m-inbound" });
    await expect(ctrl.previewV2("ws1", { headerMediaId: "m-inbound" }, req({ campaigns: ["view"] }), owner)).resolves.toMatchObject({
      connected: true,
    });
  });

  it("one connected rule: active or needs_attention connects; any other status does not (fix M3)", async () => {
    const notConnected = { status: 409, message: "campaigns.whatsapp_not_connected", code: "WHATSAPP_NOT_CONNECTED" };
    // needs_attention: connected for the banner, the launch gate and template submission.
    const na = build({ channels: [ch("N", { isDefault: true, status: "needs_attention" })] });
    const s = await na.ctrl.senders("ws1");
    expect(s.connected).toBe(true);
    // The picker still explains why it is not offered as an explicit sender.
    expect(s.senders).toEqual([expect.objectContaining({ channelId: "N", eligible: false, reason: "not_active" })]);
    expect((await na.ctrl.previewV2("ws1", { templateId: "tpl" }, req({ campaigns: ["view"] }))).connected).toBe(true);
    await expect(na.ctrl.launch("ws1", "mine", { mode: "now" })).resolves.toMatchObject({ status: "running" });
    expect(na.zernio.createWhatsAppBroadcast).toHaveBeenCalledWith(expect.objectContaining({ accountId: "acc-N" }));
    await expect(na.templates.create("ws1", { name: "x", lang: "en", category: "MARKETING", body: "Hi" })).resolves.toBeDefined();
    expect(na.zernio.createWhatsAppTemplate).toHaveBeenCalledWith(expect.objectContaining({ accountId: "acc-N" }));

    // error / pending / disconnected: not connected anywhere.
    for (const status of ["error", "pending", "disconnected"]) {
      const b = build({ channels: [ch("E", { isDefault: true, status })] });
      expect({ status, connected: (await b.ctrl.senders("ws1")).connected }).toEqual({ status, connected: false });
      expect({ status, p: (await b.ctrl.previewV2("ws1", { templateId: "tpl" }, req({ campaigns: ["view"] }))).connected }).toEqual({
        status,
        p: false,
      });
      expect({ status, e: await err(b.ctrl.launch("ws1", "mine", { mode: "now" })) }).toEqual({ status, e: expect.objectContaining(notConnected) });
      expect({ status, e: await err(b.templates.create("ws1", { name: "x", lang: "en", category: "MARKETING", body: "Hi" })) }).toEqual({
        status,
        e: expect.objectContaining(notConnected),
      });
      expect(b.zernio.createWhatsAppBroadcast).not.toHaveBeenCalled();
      expect(b.zernio.createWhatsAppTemplate).not.toHaveBeenCalled();
    }
  });

  it("GET :id returns the campaign with its senders", async () => {
    const { ctrl, prisma } = build();
    const got = (await ctrl.get("ws1", "mine")) as Record<string, unknown>;
    // No sender chosen: the default number.
    expect(got.senders).toEqual([{ channelId: "A", displayName: "Number A", phoneNumber: "+962790000001" }]);
    prisma.db.campaign[0].senderChannelIds = ["B", "A"];
    prisma.db.campaign[0].senderChannelId = "B";
    expect(((await ctrl.get("ws1", "mine")) as Record<string, unknown>).senders).toEqual([
      { channelId: "B", displayName: "Number B", phoneNumber: null },
      { channelId: "A", displayName: "Number A", phoneNumber: "+962790000001" },
    ]);
    // A deleted sender is simply absent.
    prisma.db.campaign[0].senderChannelIds = ["gone"];
    expect(((await ctrl.get("ws1", "mine")) as Record<string, unknown>).senders).toEqual([]);
  });

  it("create and update store senderChannelIds, varMap and headerMediaId with senderChannelId = primary", async () => {
    const { ctrl, prisma } = build();
    const created = (await ctrl.create("ws1", {
      name: "n",
      audience: "a",
      channel: "Broadcast",
      senderChannelIds: ["B", "A", "B"],
      varMap: { "1": { source: "field", key: "name", fallback: " friend " } },
      headerMediaId: "m1",
    })) as Record<string, unknown>;
    expect(created).toMatchObject({
      senderChannelIds: ["B", "A"],
      senderChannelId: "B",
      varMap: { "1": { source: "field", key: "name", fallback: "friend" } },
      headerMediaId: "m1",
      status: "draft",
      workspaceId: "ws1",
    });
    // Legacy only.
    const legacy = (await ctrl.update("ws1", "mine", { senderChannelId: "A" })) as Record<string, unknown>;
    expect(legacy).toMatchObject({ senderChannelIds: ["A"], senderChannelId: "A" });
    // Back to the default.
    expect(await ctrl.update("ws1", "mine", { senderChannelIds: [] })).toMatchObject({ senderChannelIds: [], senderChannelId: null });
    // Clearing the header and the map.
    expect(await ctrl.update("ws1", "mine", { headerMediaId: null, varMap: null })).toMatchObject({ headerMediaId: null, varMap: null });
    // Untouched fields stay.
    await ctrl.update("ws1", "mine", { senderChannelIds: ["A", "B"] });
    expect(await ctrl.update("ws1", "mine", { name: "renamed" })).toMatchObject({ senderChannelIds: ["A", "B"], senderChannelId: "A", name: "renamed" });
    // Conflicts, invalid senders and bad maps are refused before any write.
    const before = JSON.stringify(prisma.db.campaign);
    expect(await err(ctrl.update("ws1", "mine", { senderChannelIds: ["A"], senderChannelId: "B" }))).toMatchObject({
      status: 400,
      message: "campaigns.sender_conflict",
    });
    expect(await err(ctrl.update("ws1", "mine", { senderChannelIds: ["A", "X"] }))).toMatchObject({
      status: 400,
      message: "channels.sender_invalid",
      channelId: "X",
    });
    expect(await err(ctrl.update("ws1", "mine", { varMap: { "1": { source: "static", value: "" } } }))).toMatchObject({
      status: 400,
      message: "campaigns.var_map_invalid",
      reason: "empty_value",
    });
    expect(JSON.stringify(prisma.db.campaign)).toBe(before);
  });

  it("GET senders and POST preview are wired, samples follow contacts.view", async () => {
    const { ctrl } = build();
    const s = await ctrl.senders("ws1");
    expect(s.connected).toBe(true);
    expect(s.senders.map((x) => x.channelId)).toEqual(["A", "B"]);
    const withView = await ctrl.previewV2("ws1", { templateId: "tpl" }, req({ campaigns: ["view"], contacts: ["view"] }));
    expect(withView.samples).toHaveLength(1);
    const without = await ctrl.previewV2("ws1", { templateId: "tpl" }, req({ campaigns: ["view"] }));
    expect(without.samples).toEqual([]);
    expect(without.reachable).toBe(1);
  });

  it("whatsapp not connected returns campaigns.whatsapp_not_connected on every marketing action", async () => {
    const notConnected = { status: 409, statusCode: 409, message: "campaigns.whatsapp_not_connected", code: "WHATSAPP_NOT_CONNECTED" };
    // No WhatsApp number at all.
    const { ctrl, templates, prisma, zernio } = build({ channels: [] });
    expect(await err(ctrl.launch("ws1", "mine", { mode: "now" }))).toEqual(notConnected);
    expect(await err(templates.create("ws1", { name: "x", lang: "en", category: "MARKETING", body: "Hi" }))).toEqual(notConnected);
    expect(await err(templates.create("ws1", { name: "x", lang: "en", category: "UTILITY", libraryTemplateName: "lib" }))).toEqual(notConnected);
    expect(await err(templates.lookupLibraryTemplate("ws1", "lib"))).toEqual(notConnected);
    prisma.db.template.push({ id: "known", workspaceId: "ws1", name: "known", lang: "en", status: "approved", body: "a", metaTemplateId: "meta-1" });
    expect(await err(templates.update("ws1", "known", { body: "b" }))).toEqual(notConnected);
    expect(zernio.createWhatsAppTemplate).not.toHaveBeenCalled();
    expect(zernio.updateWhatsAppTemplate).not.toHaveBeenCalled();
    // Reads, drafts and preview do not throw it.
    await expect(templates.list("ws1")).resolves.toBeDefined();
    await expect(ctrl.create("ws1", { name: "d", audience: "a", channel: "Broadcast" })).resolves.toMatchObject({ status: "draft" });
    const p = await ctrl.previewV2("ws1", { templateId: "tpl" }, req({ campaigns: ["view"] }));
    expect(p.connected).toBe(false);
    expect((await ctrl.senders("ws1")).connected).toBe(false);
    // A local-only template still deletes.
    await expect(templates.remove("ws1", "known")).resolves.toEqual({ ok: true });

    // A number but no Zernio profile: launch is gated too.
    const noProfile = build({ profile: null });
    expect(await err(noProfile.ctrl.launch("ws1", "mine", { mode: "now" }))).toEqual(notConnected);
  });
});
