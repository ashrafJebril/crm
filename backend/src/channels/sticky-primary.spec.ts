import * as fs from "fs";
import * as path from "path";
import { ZernioService } from "../integrations/zernio.service";
import { ChannelResolver } from "./channel-resolver.service";
import { makeFakePrisma } from "./test-prisma";

/**
 * SP-19 fix round 2: N1 (sticky Zernio primary — a second number never takes
 * number A's threads), N2 (a sync never revives a hub disconnect), N3 (a
 * disconnected slot never beats a live channel), N4 (pageId index + throttle).
 */

const WA = "962790000001";

function seed(extraChannels: Record<string, unknown>[] = []) {
  return makeFakePrisma({
    workspace: [{ id: "ws1", zernioProfileId: "prof" }],
    integration: [
      {
        id: "I1",
        workspaceId: "ws1",
        platform: "whatsapp",
        provider: "zernio",
        pageId: "acc-A",
        pageName: "Number A",
        accessToken: null,
        createdAt: new Date("2026-01-01"),
        updatedAt: new Date("2026-01-01"),
      },
    ],
    channel: [
      {
        id: "chi_I1",
        workspaceId: "ws1",
        kind: "whatsapp",
        provider: "zernio",
        externalId: "acc-A",
        displayName: "Number A",
        status: "active",
        isDefault: true,
        integrationId: "I1",
        createdAt: new Date("2026-01-01"),
        updatedAt: new Date("2026-01-01"),
      },
      ...extraChannels,
    ],
    contact: [{ id: "c1", workspaceId: "ws1", externalSource: "whatsapp", externalId: WA, name: "Sara" }],
    conversation: [
      { id: "cvA", workspaceId: "ws1", contactId: "c1", channel: "whatsapp", channelId: "chi_I1", externalId: "zc-A", unread: 0, updatedAt: new Date("2026-01-01") },
    ],
  });
}

function zernio(prisma: ReturnType<typeof makeFakePrisma>, accounts: unknown[]) {
  const client = {
    isConfigured: () => true,
    listAccounts: jest.fn(async () => accounts),
    sendMessage: jest.fn(async () => ({ id: "out" })),
  };
  const svc = new ZernioService(
    prisma,
    { emitToWorkspace: jest.fn() } as never,
    {} as never,
    client as never,
    { onInboundMessage: jest.fn(async () => {}), onOutboundReply: jest.fn(async () => {}) } as never,
    { enabled: false } as never,
    { isConfigured: () => false } as never,
  );
  return { svc, client };
}

const inbound = (accountId: string, zconv: string, id: string) => ({
  event: "message.received",
  message: { id, platform: "whatsapp", direction: "incoming", text: "hi", sender: { id: WA, name: "Sara" } },
  conversation: { id: zconv, participantId: WA, participantName: "Sara" },
  account: { accountId, platform: "whatsapp" },
});

const A = { _id: "acc-A", platform: "whatsapp", displayName: "Number A" };
const B = { _id: "acc-B", platform: "whatsapp", displayName: "Number B" };

describe("second zernio number listed first does not steal number A's threads", () => {
  it("list [B, A], both healthy: A keeps its slot, threads and inbound; B gets its own row", async () => {
    const prisma = seed();
    const { svc, client } = zernio(prisma, [B, A]);
    await svc.syncAccounts("ws1");

    const slot = prisma.db.channel.find((c: { id: string }) => c.id === "chi_I1");
    expect(slot).toMatchObject({ externalId: "acc-A", integrationId: "I1", status: "active", isDefault: true });
    expect(prisma.db.integration[0].pageId).toBe("acc-A"); // sticky primary
    const b = prisma.db.channel.find((c: { externalId: string }) => c.externalId === "acc-B");
    expect(b).toMatchObject({ provider: "zernio", status: "active", isDefault: false });
    expect(b.id).not.toBe("chi_I1");

    await svc.sendInDbConversation("ws1", "cvA", "hello");
    expect(client.sendMessage).toHaveBeenLastCalledWith("zc-A", "acc-A", "hello", undefined);

    await svc.handleEvent(inbound("acc-A", "zc-A", "m1"));
    expect(prisma.db.conversation).toHaveLength(1);
    expect(prisma.db.conversation[0].unread).toBe(1);
  });

  it("A temporarily unhealthy while still listed: no in-place re-point onto B", async () => {
    const prisma = seed();
    const { svc, client } = zernio(prisma, [B, { ...A, needsReconnection: true }]);
    await svc.syncAccounts("ws1");

    const slot = prisma.db.channel.find((c: { id: string }) => c.id === "chi_I1");
    expect(slot.externalId).toBe("acc-A");
    expect(slot.status).toBe("needs_attention");
    const b = prisma.db.channel.find((c: { externalId: string }) => c.externalId === "acc-B");
    expect(b.id).not.toBe("chi_I1");

    // A's thread still addresses A (never B), and A's inbound stays in it.
    await svc.sendInDbConversation("ws1", "cvA", "hello");
    expect(client.sendMessage).toHaveBeenLastCalledWith("zc-A", "acc-A", "hello", undefined);
    await svc.handleEvent(inbound("acc-A", "zc-A", "m1"));
    expect(prisma.db.conversation).toHaveLength(1);
  });
});

describe("a sync never revives a number the user disconnected in the hub (N2)", () => {
  it("B hub-disconnected, A's sign-in expires: B is relinked at most, never reactivated", async () => {
    const prisma = seed([
      {
        id: "chB",
        workspaceId: "ws1",
        kind: "whatsapp",
        provider: "zernio",
        externalId: "acc-B",
        displayName: "Number B",
        status: "disconnected",
        statusReason: "disconnected_by_user",
        disconnectedAt: new Date("2026-02-01"),
        isDefault: false,
        integrationId: null,
        createdAt: new Date("2026-02-01"),
        updatedAt: new Date("2026-02-01"),
      },
    ]);
    const { svc } = zernio(prisma, [{ ...A, needsReconnection: true }, B]);
    await svc.syncAccounts("ws1");
    const b = prisma.db.channel.find((c: { id: string }) => c.id === "chB");
    expect(b).toMatchObject({ status: "disconnected", statusReason: "disconnected_by_user", isDefault: false });
  });
});

describe("forInbound never prefers a disconnected slot over a live channel (N3)", () => {
  it("W1's hub-disconnected legacy slot loses to W2's live channel-only number", async () => {
    const prisma = makeFakePrisma({
      integration: [
        { id: "I1", workspaceId: "ws1", platform: "whatsapp", provider: "meta", pageId: "pn-P", pageName: "", createdAt: new Date(), updatedAt: new Date() },
      ],
      channel: [
        {
          id: "w1-slot",
          workspaceId: "ws1",
          kind: "whatsapp",
          provider: "meta",
          externalId: "pn-P",
          displayName: "P",
          status: "disconnected",
          statusReason: "disconnected_by_user",
          isDefault: false,
          integrationId: "I1",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: "w2-own",
          workspaceId: "ws2",
          kind: "whatsapp",
          provider: "meta",
          externalId: "pn-P",
          displayName: "P",
          status: "active",
          isDefault: true,
          integrationId: null,
          secretsEnc: "x",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });
    expect((await new ChannelResolver(prisma).forInbound("meta", "pn-P", "whatsapp"))?.id).toBe("w2-own");
  });
});

describe("per-inbound cost (N4)", () => {
  it("Integration.pageId is indexed (schema + the unapplied channels migration)", () => {
    const sql = fs.readFileSync(path.resolve(__dirname, "../../prisma/migrations/20261112120000_channels/migration.sql"), "utf8");
    expect(sql).toContain(`CREATE INDEX IF NOT EXISTS "Integration_pageId_idx" ON "Integration"("pageId");`);
    const schema = fs.readFileSync(path.resolve(__dirname, "../../prisma/schema.prisma"), "utf8");
    expect(schema).toMatch(/model Integration \{[\s\S]*?@@index\(\[pageId\]\)[\s\S]*?\n\}/);
  });

  it("align + default-per-kind run at most once a minute per Integration", async () => {
    const prisma = makeFakePrisma({
      integration: [
        { id: "I2", workspaceId: "ws2", platform: "whatsapp", provider: "meta", pageId: "pn-P", pageName: "", createdAt: new Date(), updatedAt: new Date() },
      ],
      channel: [
        // W1 orphan with no Integration: forces the mirror path on every event.
        { id: "orphan", workspaceId: "ws1", kind: "whatsapp", provider: "meta", externalId: "pn-Q", displayName: "Q", status: "active", isDefault: true, integrationId: null, createdAt: new Date(), updatedAt: new Date() },
      ],
    });
    const r = new ChannelResolver(prisma);
    // The Integration's slot is hub-disconnected, so it never becomes tier 1.
    await r.forInbound("meta", "pn-P", "whatsapp");
    prisma.db.channel.find((c: { integrationId: string }) => c.integrationId === "I2").status = "disconnected";
    prisma.channel.findMany.mockClear();
    prisma.channel.create.mockClear();
    await r.forInbound("meta", "pn-P", "whatsapp");
    await r.forInbound("meta", "pn-P", "whatsapp");
    // only the candidate lookup per event; no ensureDefaultPerKind scans
    expect(prisma.channel.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.channel.create).not.toHaveBeenCalled();
  });
});
