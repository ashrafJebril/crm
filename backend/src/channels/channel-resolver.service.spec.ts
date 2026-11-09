import { ChannelResolver, pickEffectiveChannel } from "./channel-resolver.service";
import { channelErrorKey } from "./channel-errors";
import { makeFakePrisma } from "./test-prisma";

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

const conv = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  workspaceId: "ws1",
  contactId: "c1",
  channel: "whatsapp",
  channelId: null,
  updatedAt: new Date("2026-01-01"),
  ...over,
});

describe("ChannelResolver", () => {
  describe("legacy null channelId conversation is adopted by the legacy channel only", () => {
    const seed = () =>
      makeFakePrisma({
        integration: [{ id: "int-a", workspaceId: "ws1", platform: "whatsapp", provider: "zernio", pageId: "acc-A", pageName: "A", createdAt: new Date() }],
        channel: [
          ch("A", { externalId: "acc-A", integrationId: "int-a", isDefault: true }),
          ch("B", { externalId: "acc-B" }),
        ],
        conversation: [conv("legacy")],
      });

    it("number B does not adopt the legacy thread; it gets its own", async () => {
      const prisma = seed();
      const r = new ChannelResolver(prisma);
      const B = prisma.db.channel[1];
      expect(await r.findOrAdoptConversation("ws1", "c1", B)).toBeNull();
      // B's miss still settled the legacy row on its real owner (A), never on B.
      expect(prisma.db.conversation[0].channelId).toBe("A");
    });

    it("the legacy (integration-linked) channel adopts it and writes channelId back", async () => {
      const prisma = seed();
      const r = new ChannelResolver(prisma);
      const A = prisma.db.channel[0];
      const found = await r.findOrAdoptConversation("ws1", "c1", A);
      expect(found?.id).toBe("legacy");
      expect(prisma.db.conversation[0].channelId).toBe("A");
    });

    it("write-back only fills a null channelId (raw SQL, no updatedAt bump)", async () => {
      const prisma = seed();
      const r = new ChannelResolver(prisma);
      await r.effectiveChannel(prisma.db.conversation[0]);
      const [strings] = prisma.$executeRaw.mock.calls[0];
      expect(strings.join("?")).toMatch(/"channelId" IS NULL/);
      expect(prisma.conversation.update).not.toHaveBeenCalled();
    });

    it("without a legacy integration, the active default of the kind is used", async () => {
      const prisma = makeFakePrisma({
        channel: [ch("A"), ch("B", { isDefault: true })],
        conversation: [conv("legacy")],
      });
      const r = new ChannelResolver(prisma);
      expect((await r.effectiveChannel(prisma.db.conversation[0]))?.id).toBe("B");
    });

    it("l and webchat legacy threads resolve to nothing", () => {
      const list = [ch("W", { kind: "webchat", isDefault: true, provider: "native", externalId: null })];
      expect(pickEffectiveChannel(conv("x", { channel: "l" }), list)).toBeNull();
      expect(pickEffectiveChannel(conv("x", { channel: "webchat" }), list)).toBeNull();
    });
  });

  describe("send on disconnected channel is refused", () => {
    it("409 channels.disconnected for a conversation on a disconnected channel, no fallback", async () => {
      const prisma = makeFakePrisma({
        channel: [ch("A", { status: "disconnected" }), ch("B", { isDefault: true })],
        conversation: [conv("x", { channelId: "A" })],
      });
      const r = new ChannelResolver(prisma);
      const err = await r.forSend("ws1", prisma.db.conversation[0]).catch((e) => e);
      expect(err.getStatus()).toBe(409);
      expect(channelErrorKey(err)).toBe("channels.disconnected");
    });

    it("a legacy thread whose integration-linked channel is disconnected is refused too", async () => {
      const prisma = makeFakePrisma({
        channel: [
          ch("A", { status: "disconnected", integrationId: "int-a" }),
          ch("B", { isDefault: true }),
        ],
        conversation: [conv("legacy")],
      });
      const r = new ChannelResolver(prisma);
      const err = await r.forSend("ws1", prisma.db.conversation[0]).catch((e) => e);
      expect(channelErrorKey(err)).toBe("channels.disconnected");
    });

    it("409 channels.not_connected when nothing resolves", async () => {
      const prisma = makeFakePrisma({ conversation: [conv("x")] });
      const err = await new ChannelResolver(prisma).forSend("ws1", prisma.db.conversation[0]).catch((e) => e);
      expect(err.getStatus()).toBe(409);
      expect(channelErrorKey(err)).toBe("channels.not_connected");
    });

    it("returns the active channel otherwise", async () => {
      const prisma = makeFakePrisma({ channel: [ch("A")], conversation: [conv("x", { channelId: "A" })] });
      expect((await new ChannelResolver(prisma).forSend("ws1", prisma.db.conversation[0])).id).toBe("A");
    });
  });

  describe("forInbound", () => {
    it("matches by provider + externalId", async () => {
      const prisma = makeFakePrisma({ channel: [ch("A"), ch("B")] });
      expect((await new ChannelResolver(prisma).forInbound("zernio", "acc-B"))?.id).toBe("B");
    });

    it("meta matches any non-zernio legacy provider of the kind", async () => {
      const prisma = makeFakePrisma({
        channel: [ch("M", { provider: "kapso", externalId: "pn-1" }), ch("Z", { externalId: "pn-1" })],
      });
      expect((await new ChannelResolver(prisma).forInbound("meta", "pn-1", "whatsapp"))?.id).toBe("M");
    });

    it("mirrors a legacy Integration that has no channel yet, so nothing is dropped", async () => {
      const prisma = makeFakePrisma({
        integration: [{ id: "int-x", workspaceId: "ws9", platform: "whatsapp", provider: "meta", pageId: "pn-7", pageName: "", createdAt: new Date() }],
      });
      const got = await new ChannelResolver(prisma).forInbound("meta", "pn-7", "whatsapp");
      expect(got).toMatchObject({ id: "chi_int-x", workspaceId: "ws9", externalId: "pn-7" });
    });

    it("warns and picks the most recently updated active row when several workspaces match", async () => {
      const prisma = makeFakePrisma({
        channel: [
          ch("old", { workspaceId: "ws1", externalId: "dup", updatedAt: new Date("2026-01-01") }),
          ch("new", { workspaceId: "ws2", externalId: "dup", updatedAt: new Date("2026-02-01") }),
          ch("gone", { workspaceId: "ws3", externalId: "dup", status: "disconnected", updatedAt: new Date("2026-03-01") }),
        ],
      });
      const r = new ChannelResolver(prisma);
      const warn = jest.spyOn((r as unknown as { log: { warn: () => void } }).log, "warn").mockImplementation(() => {});
      expect((await r.forInbound("zernio", "dup"))?.id).toBe("new");
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it("unknown account returns null", async () => {
      const prisma = makeFakePrisma();
      expect(await new ChannelResolver(prisma).forInbound("zernio", "nope")).toBeNull();
    });
  });
});
