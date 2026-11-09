import { ZernioService } from "../integrations/zernio.service";
import { makeFakePrisma } from "./test-prisma";

/**
 * SP-19 fix round 3 (R1, R2): a Zernio legacy slot moves only on strong
 * identity (same WhatsApp phone / same handle) while its old account is still
 * listed; once the old account is gone, it follows the Integration (in place,
 * or merged into the Integration's current channel) — `main`'s behaviour.
 */

const WA = "962790000001";

function seed() {
  return makeFakePrisma({
    workspace: [{ id: "ws1", zernioProfileId: "prof" }],
    integration: [
      {
        id: "I1",
        workspaceId: "ws1",
        platform: "whatsapp",
        provider: "zernio",
        pageId: "acc-A",
        pageName: "Acme",
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
        displayName: "Acme",
        status: "active",
        isDefault: true,
        integrationId: "I1",
        createdAt: new Date("2026-01-01"),
        updatedAt: new Date("2026-01-01"),
      },
    ],
    contact: [{ id: "c1", workspaceId: "ws1", externalSource: "whatsapp", externalId: WA, name: "Sara" }],
    conversation: [
      { id: "cvA", workspaceId: "ws1", contactId: "c1", channel: "whatsapp", channelId: "chi_I1", externalId: "zc-A", unread: 0, updatedAt: new Date("2026-01-01") },
    ],
  });
}

function zernio(prisma: ReturnType<typeof makeFakePrisma>) {
  const client = {
    isConfigured: () => true,
    listAccounts: jest.fn(async (): Promise<unknown[]> => []),
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

describe("same display name different number does not move threads", () => {
  it.each([
    ["different phones", { phoneNumber: "+962790000010" }, { phoneNumber: "+962790000020" }],
    ["no strong identifier at all", {}, {}],
  ])("%s: A broken but listed, B named the same — A's slot and threads stay on A", async (_label, metaA, metaB) => {
    const prisma = seed();
    const { svc, client } = zernio(prisma);
    client.listAccounts.mockResolvedValue([
      { _id: "acc-A", platform: "whatsapp", displayName: "Acme", needsReconnection: true, metadata: metaA },
      { _id: "acc-B", platform: "whatsapp", displayName: "Acme", metadata: metaB },
    ]);
    await svc.syncAccounts("ws1");

    const slot = prisma.db.channel.find((c: { id: string }) => c.id === "chi_I1");
    expect(slot.externalId).toBe("acc-A");
    expect(prisma.db.conversation[0].channelId).toBe("chi_I1");
    await svc.sendInDbConversation("ws1", "cvA", "hello");
    expect(client.sendMessage).toHaveBeenLastCalledWith("zc-A", "acc-A", "hello", undefined);
    await svc.handleEvent(inbound("acc-A", "zc-A", "m1"));
    expect(prisma.db.conversation).toHaveLength(1);
  });

  it("the same WhatsApp phone (strong identity) does move the slot in place", async () => {
    const prisma = seed();
    const { svc, client } = zernio(prisma);
    client.listAccounts.mockResolvedValue([
      { _id: "acc-A", platform: "whatsapp", needsReconnection: true, metadata: { phoneNumber: "+962 79 000 0010" } },
      { _id: "acc-A2", platform: "whatsapp", metadata: { phoneNumber: "962790000010" } },
    ]);
    await svc.syncAccounts("ws1");
    expect(prisma.db.channel.find((c: { id: string }) => c.id === "chi_I1").externalId).toBe("acc-A2");
  });
});

describe("re-auth without name match then old account drops recovers replies", () => {
  it("cvA replies via the new account again and stays one conversation", async () => {
    const prisma = seed();
    const { svc, client } = zernio(prisma);

    // Sync 1: the revoked A is still listed, no strong identity → no move.
    client.listAccounts.mockResolvedValue([
      { _id: "acc-A", platform: "whatsapp", needsReconnection: true },
      { _id: "acc-A2", platform: "whatsapp", displayName: "Something else" },
    ]);
    await svc.syncAccounts("ws1");
    expect(prisma.db.channel.find((c: { id: string }) => c.id === "chi_I1").externalId).toBe("acc-A");

    // Sync 2: A has dropped off the list → the slot follows the Integration.
    client.listAccounts.mockResolvedValue([{ _id: "acc-A2", platform: "whatsapp", displayName: "Something else" }]);
    await svc.syncAccounts("ws1");

    await svc.handleEvent(inbound("acc-A2", "zc-A2", "m1"));
    expect(prisma.db.conversation).toHaveLength(1);
    expect(prisma.db.conversation[0]).toMatchObject({ id: "cvA", externalId: "zc-A2" });

    await svc.sendInDbConversation("ws1", "cvA", "hello");
    expect(client.sendMessage).toHaveBeenLastCalledWith("zc-A2", "acc-A2", "hello", undefined);
  });
});
