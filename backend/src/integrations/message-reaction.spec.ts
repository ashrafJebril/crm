import { ZernioService } from "./zernio.service";
import { WhatsAppService } from "./whatsapp.service";
import { normalizeReaction } from "./message-reaction";

describe("normalizeReaction", () => {
  it("keeps an emoji, clears on empty/absent, ignores oversize or non-strings", () => {
    expect(normalizeReaction("👍")).toBe("👍");
    expect(normalizeReaction("")).toBeNull();
    expect(normalizeReaction("   ")).toBeNull();
    expect(normalizeReaction(undefined)).toBeNull();
    expect(normalizeReaction("x".repeat(17))).toBeUndefined();
    expect(normalizeReaction(5)).toBeUndefined();
  });
});

describe("Zernio reaction.received", () => {
  function build(integ: any = { workspaceId: "ws1", platform: "whatsapp", provider: "zernio", pageId: "acc1" }) {
    const prisma = {
      integration: { findFirst: jest.fn(async () => integ) },
      message: { updateMany: jest.fn(async () => ({ count: 1 })), findFirst: jest.fn(async () => null) },
    };
    const realtime = { emitToWorkspace: jest.fn() };
    const svc = new ZernioService(
      prisma as never, realtime as never, {} as never, {} as never, {} as never,
      { enabled: false } as never, {} as never,
    );
    return { svc, prisma, realtime };
  }
  const evt = (reaction: any, extra: any = {}) => ({
    type: "reaction.received",
    account: { accountId: "acc1" },
    reaction,
    ...extra,
  });

  it("updates exactly the target message in that workspace", async () => {
    const { svc, prisma, realtime } = build();
    await svc.handleEvent(evt({ emoji: "❤️", messageId: "zm1", platformMessageId: "wamid.1" }) as never);
    const arg = (prisma.message.updateMany.mock.calls[0] as any)[0];
    expect(arg.where).toEqual({ workspaceId: "ws1", metaMessageId: { in: ["zm1", "wamid.1"] } });
    expect(arg.data.reaction).toBe("❤️");
    expect(arg.data.reactionAt).toBeInstanceOf(Date);
    expect(realtime.emitToWorkspace).toHaveBeenCalledWith("ws1", "inbox.activity", expect.anything());
  });

  it("an empty emoji removes the reaction", async () => {
    const { svc, prisma } = build();
    await svc.handleEvent(evt({ emoji: "", messageId: "zm1" }) as never);
    const arg = (prisma.message.updateMany.mock.calls[0] as any)[0];
    expect(arg.data).toEqual({ reaction: null, reactionAt: null });
  });

  it("ignores an unknown message id (no row updated, no realtime) and unknown accounts", async () => {
    const { svc, prisma, realtime } = build();
    prisma.message.updateMany.mockResolvedValueOnce({ count: 0 });
    const r = await svc.handleEvent(evt({ emoji: "👍", messageId: "nope" }) as never);
    expect(r).toMatchObject({ ok: true });
    expect(realtime.emitToWorkspace).not.toHaveBeenCalled();

    const none = build(null);
    await none.svc.handleEvent(evt({ emoji: "👍", messageId: "zm1" }) as never);
    expect(none.prisma.message.updateMany).not.toHaveBeenCalled();
  });

  it("a payload without an emoji key is ignored (only an explicit empty string removes)", async () => {
    const { svc, prisma } = build();
    await svc.handleEvent(evt({ messageId: "zm1" }) as never);
    await svc.handleEvent(evt({ emoji: null, messageId: "zm1" }) as never);
    expect(prisma.message.updateMany).not.toHaveBeenCalled();
  });

  it("ignores events without a target id or with an oversize emoji", async () => {
    const { svc, prisma } = build();
    await svc.handleEvent(evt({ emoji: "👍" }) as never);
    await svc.handleEvent(evt({ emoji: "x".repeat(40), messageId: "zm1" }) as never);
    expect(prisma.message.updateMany).not.toHaveBeenCalled();
  });
});

describe("Meta WhatsApp reaction webhook", () => {
  function build() {
    const prisma = {
      integration: {
        findFirst: jest.fn(async () => ({ id: "i1", workspaceId: "ws1", platform: "whatsapp", pageId: "pn1" })),
        update: jest.fn(async () => ({})),
      },
      message: { updateMany: jest.fn(async () => ({ count: 1 })) },
    };
    const realtime = { emitToWorkspace: jest.fn() };
    const svc = new WhatsAppService(prisma as never, realtime as never, {} as never, {} as never, {} as never);
    const ingest = jest.spyOn(svc as any, "ingestInbound").mockResolvedValue(undefined);
    return { svc, prisma, realtime, ingest };
  }
  const payload = (msg: any) => ({
    object: "whatsapp_business_account",
    entry: [{ id: "waba", changes: [{ field: "messages", value: { metadata: { phone_number_id: "pn1" }, messages: [msg] } }] }],
  });

  it("updates the reacted message by wamid, scoped to the workspace, and is not ingested as a message", async () => {
    const { svc, prisma, ingest } = build();
    await svc.handleWebhook(payload({ from: "962", id: "wamid.R", timestamp: "1", type: "reaction", reaction: { message_id: "wamid.T", emoji: "👍" } }) as never);
    const arg = (prisma.message.updateMany.mock.calls[0] as any)[0];
    expect(arg.where).toEqual({ workspaceId: "ws1", metaMessageId: "wamid.T" });
    expect(arg.data.reaction).toBe("👍");
    expect(ingest).not.toHaveBeenCalled();
  });

  it("an empty emoji removes it; an unknown id changes nothing and emits nothing", async () => {
    const { svc, prisma, realtime } = build();
    await svc.handleWebhook(payload({ from: "962", id: "w", timestamp: "1", type: "reaction", reaction: { message_id: "wamid.T", emoji: "" } }) as never);
    expect((prisma.message.updateMany.mock.calls[0] as any)[0].data).toEqual({ reaction: null, reactionAt: null });

    realtime.emitToWorkspace.mockClear();
    prisma.message.updateMany.mockResolvedValueOnce({ count: 0 });
    await svc.handleWebhook(payload({ from: "962", id: "w", timestamp: "1", type: "reaction", reaction: { message_id: "unknown", emoji: "👍" } }) as never);
    expect(realtime.emitToWorkspace).not.toHaveBeenCalled();
  });

  it("still ingests ordinary messages", async () => {
    const { svc, ingest } = build();
    await svc.handleWebhook(payload({ from: "962", id: "w", timestamp: "1", type: "text", text: { body: "hi" } }) as never);
    expect(ingest).toHaveBeenCalled();
  });
});
