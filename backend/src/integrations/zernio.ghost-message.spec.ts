import { ZernioService } from "./zernio.service";
import { makeFakePrisma } from "../channels/test-prisma";

/**
 * Comment automations send a Private Reply DM, and Zernio then delivers an
 * event for that DM which our handler read wrongly in two ways at once: the
 * body was somewhere it did not look, and nothing said the message was
 * outgoing. The result was a second, empty message filed as if the CUSTOMER
 * had written it, reading "[instagram message]".
 *
 * Observed live 2026-11-26 — three Instagram threads, each holding the real
 * outbound DM plus a ghost inbound copy a couple of seconds later with no id,
 * so the usual deduplication could not catch it either.
 */

const igChannel = {
  id: "ch-ig",
  workspaceId: "ws1",
  kind: "instagram",
  provider: "zernio",
  externalId: "acc-ig",
  displayName: "kewy_ai",
  status: "active",
  isDefault: true,
  integrationId: null,
  secretsEnc: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

function build(prisma: ReturnType<typeof makeFakePrisma>) {
  const svc = new ZernioService(
    prisma,
    { emitToWorkspace: jest.fn() } as never,
    {} as never,
    {} as never,
    { onInboundMessage: jest.fn(async () => {}), onOutboundReply: jest.fn(async () => {}) } as never,
    { enabled: false } as never,
    { isConfigured: () => false } as never,
  );
  return svc;
}

const base = (over: Record<string, unknown>) => ({
  event: "message.received",
  conversation: { id: "zc-1", participantId: "ig-user-1", participantName: "ashrafjib" },
  account: { accountId: "acc-ig", platform: "instagram" },
  ...over,
});

const bodies = (prisma: ReturnType<typeof makeFakePrisma>) =>
  prisma.db.message.map((m: { body: string; from: string }) => ({ body: m.body, from: m.from }));

describe("a DM Zernio sent for us is not the customer talking", () => {
  it("reads the body from `message` when `text` is absent", async () => {
    // Zernio's REST message objects carry the body under `message`; some
    // webhook deliveries use that same shape. Reading only `text` turned a
    // real sentence into "[instagram message]".
    const prisma = makeFakePrisma({ channel: [igChannel] });
    await build(prisma).handleEvent(
      base({
        message: {
          id: "m-1",
          platform: "instagram",
          message: "Hello Kewy, you are welcome",
          sender: { id: "ig-user-1" },
        },
      }),
    );
    expect(bodies(prisma)).toEqual([{ body: "Hello Kewy, you are welcome", from: "them" }]);
  });

  it("files an automation's DM as ours, even with no direction", async () => {
    const prisma = makeFakePrisma({ channel: [igChannel] });
    await build(prisma).handleEvent(
      base({
        message: {
          id: "m-2",
          platform: "instagram",
          message: "Thanks for commenting — check your DMs",
          sentVia: "comment_automation",
          automationId: "auto-1",
          sender: { id: "acc-ig" },
        },
      }),
    );
    const [row] = bodies(prisma);
    expect(row.from).toBe("human");
  });

  it("ignores an event carrying nothing at all", async () => {
    // No body, no attachment, no id: it says nothing, and without an id the
    // dedupe cannot stop it being stored again. This is the ghost.
    const prisma = makeFakePrisma({ channel: [igChannel] });
    await build(prisma).handleEvent(
      base({ message: { platform: "instagram", sender: { id: "ig-user-1" } } }),
    );
    expect(bodies(prisma)).toEqual([]);
  });

  it("still keeps a media-only message, which has no text but does say something", async () => {
    const prisma = makeFakePrisma({ channel: [igChannel] });
    await build(prisma).handleEvent(
      base({
        message: {
          id: "m-3",
          platform: "instagram",
          attachments: [{ type: "image", url: "https://cdn.test/a.jpg" }],
          sender: { id: "ig-user-1" },
        },
      }),
    );
    expect(bodies(prisma)).toEqual([{ body: "[image]", from: "them" }]);
  });

  it("keeps an empty message that at least has an id, so dedupe can hold it", async () => {
    const prisma = makeFakePrisma({ channel: [igChannel] });
    await build(prisma).handleEvent(
      base({ message: { id: "m-4", platform: "instagram", sender: { id: "ig-user-1" } } }),
    );
    expect(bodies(prisma)).toEqual([{ body: "[instagram message]", from: "them" }]);
  });
});
