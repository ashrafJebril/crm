import { makeFakePrisma } from "../../channels/test-prisma";
import { CampaignPreviewService } from "./campaign-preview.service";

const ch = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  workspaceId: "ws1",
  kind: "whatsapp",
  provider: "zernio",
  externalId: `acc-${id}`,
  displayName: `Number ${id}`,
  phoneNumber: `+96279000000${id.charCodeAt(0) - 64}`,
  status: "active",
  isDefault: false,
  integrationId: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  ...over,
});

const NAMES = ["Sara", "Omar", "ليلى", "Hadi", "Rana", "Ziad", "Nour", "Faris", "Dana", "Yousef", "Lina", "Sami"];

function fixture(opts: { profile?: string | null } = {}) {
  const contacts: Record<string, unknown>[] = [];
  const values: Record<string, unknown>[] = [];
  NAMES.forEach((name, i) => {
    const id = `c${String(i + 1).padStart(2, "0")}`;
    contacts.push({
      id,
      workspaceId: "ws1",
      name,
      firstName: null,
      lastName: null,
      email: null,
      phone: `+9627910000${String(i + 1).padStart(2, "0")}`,
      lifecycle: "lead",
      marketingOptOut: false,
    });
    // c02 has no city (fallback); c03 and c07 have no service date (skipped).
    if (id !== "c02") values.push({ defId: "d-city", contactId: id, value: i % 2 ? "Irbid" : "عمّان" });
    if (id !== "c03" && id !== "c07") values.push({ defId: "d-due", contactId: id, value: `2026-12-${String(i + 1).padStart(2, "0")}` });
  });
  const base = { workspaceId: "ws1", firstName: null, lastName: null, email: null, lifecycle: "lead", marketingOptOut: false };
  contacts.push({ ...base, id: "c13", name: "Opted", phone: "+962791999913", marketingOptOut: true });
  contacts.push({ ...base, id: "c14", name: "NoPhone", phone: null });
  contacts.push({ ...base, id: "c15", name: "Dup", phone: "+962791000001" });
  // Another workspace: its contacts and its "vip" field never show up.
  contacts.push({ ...base, id: "c99", workspaceId: "ws2", name: "Foreign", phone: "+962791999999" });

  const prisma = makeFakePrisma({
    workspace: [
      { id: "ws1", plan: "pro", zernioProfileId: opts.profile === undefined ? "prof1" : opts.profile },
      { id: "ws2", plan: "pro", zernioProfileId: "prof2" },
    ],
    channel: [ch("A", { isDefault: true }), ch("B"), ch("C"), ch("X", { workspaceId: "ws2" })],
    template: [
      { id: "tpl", workspaceId: "ws1", name: "service_due", lang: "en", status: "approved", body: "Hi {{1}}, your {{2}} visit is on {{3}}." },
      { id: "tpl-b", workspaceId: "ws2", name: "x", lang: "en", status: "approved", body: "x" },
    ],
    customFieldDef: [
      { id: "d-city", workspaceId: "ws1", entity: "contact", key: "city", label: "City", labelAr: "المدينة", type: "text", options: null, archivedAt: null },
      { id: "d-due", workspaceId: "ws1", entity: "contact", key: "service_due", label: "Service due", labelAr: "موعد الخدمة", type: "date", options: null, archivedAt: null },
      { id: "d-vip", workspaceId: "ws2", entity: "contact", key: "vip", label: "VIP", labelAr: "VIP", type: "text", options: null, archivedAt: null },
    ],
    contact: contacts,
    customFieldValue: values,
    media: [
      { id: "m1", workspaceId: "ws1", mimeType: "image/png", fileName: "a.png", sizeBytes: 10, storedPath: "a", storageKind: "local" },
      { id: "m2", workspaceId: "ws2", mimeType: "image/png", fileName: "b.png", sizeBytes: 10, storedPath: "b", storageKind: "local" },
    ],
  });
  const approved = { id: "t", name: "service_due", status: "APPROVED", category: "MARKETING", language: "en", components: [{ type: "BODY", text: "Hi {{1}}, your {{2}} visit is on {{3}}." }] };
  const zernio = {
    whatsappTemplates: jest.fn(async (acc: string) => (acc === "acc-C" ? [] : [approved])),
  };
  const svc = new CampaignPreviewService(prisma, zernio as never);
  return { prisma, zernio, svc };
}

const VAR_MAP = {
  "1": { source: "field", key: "name" },
  "2": { source: "custom", key: "city", fallback: "your city" },
  "3": { source: "custom", key: "service_due" },
};

const err = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return { status: (e as { getStatus(): number }).getStatus(), ...(e as { getResponse(): object }).getResponse() };
  }
  return null;
};

describe("CampaignPreviewService", () => {
  const OLD = { ...process.env };
  afterEach(() => {
    process.env = { ...OLD };
  });

  it("preview splits, counts missing values and samples real contacts", async () => {
    const { svc, prisma, zernio } = fixture();
    const r = await svc.preview(
      "ws1",
      { templateId: "tpl", senderChannelIds: ["A", "B", "C"], varMap: VAR_MAP },
      { canViewContacts: true },
    );
    expect(r.connected).toBe(true);
    expect(r.total).toBe(15);
    // 12 with phones; 2 skipped for a missing service date → 10 reachable.
    expect(r.reachable).toBe(10);
    expect(r.skipped).toEqual({ noPhone: 1, optedOut: 1, duplicate: 1, missingValue: 2 });
    expect(r.missingByKey).toEqual([{ source: "custom", key: "service_due", label: "Service due", labelAr: "موعد الخدمة", count: 2 }]);
    // 10 reachable over 3 numbers, round-robin: 4/3/3, largest first.
    expect(r.split).toEqual([
      { channelId: "A", displayName: "Number A", phoneNumber: "+962790000001", recipients: 4 },
      { channelId: "B", displayName: "Number B", phoneNumber: "+962790000002", recipients: 3 },
      { channelId: "C", displayName: "Number C", phoneNumber: "+962790000003", recipients: 3 },
    ]);
    // C lacks the template; one read per account.
    expect(r.templateMissing).toEqual(["C"]);
    expect(r.templateCheckFailed).toEqual([]);
    expect(zernio.whatsappTemplates).toHaveBeenCalledTimes(3);
    // Every reachable recipient has its own service date → 10 partitions ≤ 25 → broadcasts.
    expect(r.transport).toEqual({ kind: "broadcast", partitions: 10, limit: 25, directLimit: 5000 });
    // Samples: real contacts, the first reachable, the first that used a fallback, the first skipped.
    expect(r.samples).toEqual([
      {
        contactId: "c01",
        name: "Sara",
        rendered: "Hi Sara, your عمّان visit is on 2026-12-01.",
        values: ["Sara", "عمّان", "2026-12-01"],
        usedFallback: [],
        skippedFor: null,
      },
      {
        contactId: "c02",
        name: "Omar",
        rendered: "Hi Omar, your your city visit is on 2026-12-02.",
        values: ["Omar", "your city", "2026-12-02"],
        usedFallback: [2],
        skippedFor: null,
      },
      {
        contactId: "c03",
        name: "ليلى",
        rendered: "Hi ليلى, your عمّان visit is on {{3}}.",
        values: ["ليلى", "عمّان", ""],
        usedFallback: [],
        skippedFor: { source: "custom", key: "service_due" },
      },
    ]);
    expect(r.estimate.usd).toBeCloseTo(10 * 0.0392, 6);
    expect(r.estimate.unpriced).toBe(0);
    // It writes nothing.
    for (const m of ["campaignRecipient", "campaignBroadcast", "campaign"]) {
      for (const op of ["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"]) {
        expect({ m, op, n: prisma[m][op].mock.calls.length }).toEqual({ m, op, n: 0 });
      }
    }
  });

  it("no samples without contacts.view", async () => {
    const { svc } = fixture();
    const r = await svc.preview("ws1", { templateId: "tpl", varMap: VAR_MAP }, { canViewContacts: false });
    expect(r.samples).toEqual([]);
    expect(r.reachable).toBe(10);
    // The default number alone.
    expect(r.split).toEqual([{ channelId: "A", displayName: "Number A", phoneNumber: "+962790000001", recipients: 10 }]);
  });

  it("transport.kind is too_varied above both caps, direct when the header file forces it", async () => {
    const { svc } = fixture();
    process.env.CAMPAIGN_MAX_PARTITIONS = "2";
    process.env.CAMPAIGN_DIRECT_MAX = "5";
    const r = await svc.preview("ws1", { templateId: "tpl", senderChannelIds: ["A", "B"], varMap: VAR_MAP }, { canViewContacts: true });
    expect(r.transport).toEqual({ kind: "too_varied", partitions: 10, limit: 2, directLimit: 5 });
    process.env.CAMPAIGN_DIRECT_MAX = "10";
    const d = await svc.preview("ws1", { templateId: "tpl", varMap: VAR_MAP }, { canViewContacts: true });
    expect(d.transport.kind).toBe("direct");
    delete process.env.CAMPAIGN_MAX_PARTITIONS;
    delete process.env.CAMPAIGN_DIRECT_MAX;
    // R8: a campaign header file forces direct sends.
    const h = await svc.preview("ws1", { templateId: "tpl", varMap: { "1": { source: "static", value: "Hi" }, "2": { source: "static", value: "x" }, "3": { source: "static", value: "y" } }, headerMediaId: "m1" }, { canViewContacts: true });
    expect(h.transport).toMatchObject({ kind: "direct", partitions: 1 });
  });

  it("preview gives connected:false with 200 when WhatsApp is not connected", async () => {
    const { svc, zernio } = fixture({ profile: null });
    const r = await svc.preview("ws1", { templateId: "tpl", senderChannelIds: ["A"], varMap: VAR_MAP }, { canViewContacts: true });
    expect(r.connected).toBe(false);
    expect(r.split).toEqual([]);
    expect(r.templateMissing).toEqual([]);
    expect(r.reachable).toBe(10);
    expect(zernio.whatsappTemplates).not.toHaveBeenCalled();
  });

  it("body references are validated in this workspace only", async () => {
    const { svc } = fixture();
    // Foreign sender → 400 channels.sender_invalid (ruling 11).
    expect(await err(svc.preview("ws1", { senderChannelIds: ["X"] }, { canViewContacts: true }))).toMatchObject({
      status: 400,
      message: "channels.sender_invalid",
    });
    // Foreign template → 400, never 404.
    expect(await err(svc.preview("ws1", { templateId: "tpl-b" }, { canViewContacts: true }))).toMatchObject({
      status: 400,
      message: "campaigns.template_not_approved",
    });
    // A custom key only workspace B defines → 400 var_map_invalid.
    expect(
      await err(svc.preview("ws1", { templateId: "tpl", varMap: { ...VAR_MAP, "2": { source: "custom", key: "vip" } } }, { canViewContacts: true })),
    ).toMatchObject({ status: 400, message: "campaigns.var_map_invalid", slot: "2", reason: "unknown_custom_field" });
    // Foreign media → 404.
    expect(await err(svc.preview("ws1", { templateId: "tpl", varMap: VAR_MAP, headerMediaId: "m2" }, { canViewContacts: true }))).toMatchObject({
      status: 404,
    });
    // Conflicting sender fields.
    expect(await err(svc.preview("ws1", { senderChannelIds: ["A"], senderChannelId: "B" }, { canViewContacts: true }))).toMatchObject({
      status: 400,
      message: "campaigns.sender_conflict",
    });
  });

  it("without a template or varMap it still counts the audience", async () => {
    const { svc } = fixture();
    const r = await svc.preview("ws1", {}, { canViewContacts: true });
    expect(r).toMatchObject({ total: 15, reachable: 12, skipped: { noPhone: 1, optedOut: 1, duplicate: 1, missingValue: 0 }, samples: [], templateMissing: [] });
    expect(r.transport).toMatchObject({ kind: "broadcast", partitions: 1 });
  });
});
