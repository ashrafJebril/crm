import { assertWhatsappCapacity, CHANNEL_LIMITS, whatsappLimit, whatsappUsage } from "./channel-limits";
import { channelErrorKey } from "./channel-errors";
import { makeFakePrisma } from "./test-prisma";

describe("channel limits", () => {
  it("plan table (R3) with a free fallback for unknown plans", () => {
    expect(CHANNEL_LIMITS).toEqual({ free: 1, starter: 1, growth: 3, pro: 10 });
    expect(whatsappLimit("pro", {})).toBe(10);
    expect(whatsappLimit("mystery", {})).toBe(1);
  });

  it("CHANNEL_WHATSAPP_LIMIT overrides every plan; junk is ignored", () => {
    expect(whatsappLimit("free", { CHANNEL_WHATSAPP_LIMIT: "5" })).toBe(5);
    expect(whatsappLimit("pro", { CHANNEL_WHATSAPP_LIMIT: "abc" })).toBe(10);
    expect(whatsappLimit("pro", { CHANNEL_WHATSAPP_LIMIT: "0" })).toBe(10);
  });

  it("pending rows idle for more than 24 h stop counting (m5); fresh ones still count", async () => {
    const prev = process.env.CHANNEL_WHATSAPP_LIMIT;
    delete process.env.CHANNEL_WHATSAPP_LIMIT;
    const old = new Date(Date.now() - 25 * 3600_000);
    const prisma = makeFakePrisma({
      workspace: [{ id: "ws1", plan: "free" }],
      channel: [{ id: "p", workspaceId: "ws1", kind: "whatsapp", status: "pending", updatedAt: old, createdAt: old }],
    });
    try {
      expect(await whatsappUsage(prisma, "ws1")).toMatchObject({ used: 0 });
      await expect(assertWhatsappCapacity(prisma, "ws1")).resolves.toBeUndefined();
      prisma.db.channel[0].updatedAt = new Date();
      expect(await whatsappUsage(prisma, "ws1")).toMatchObject({ used: 1 });
    } finally {
      if (prev !== undefined) process.env.CHANNEL_WHATSAPP_LIMIT = prev;
    }
  });

  it("counts non-disconnected WhatsApp channels and gates adds with 409 channels.limit_reached", async () => {
    const prisma = makeFakePrisma({
      workspace: [{ id: "ws1", plan: "free" }],
      channel: [
        { id: "a", workspaceId: "ws1", kind: "whatsapp", status: "active" },
        { id: "b", workspaceId: "ws1", kind: "whatsapp", status: "disconnected" },
        { id: "c", workspaceId: "ws1", kind: "telegram", status: "active" },
      ],
    });
    const prev = process.env.CHANNEL_WHATSAPP_LIMIT;
    delete process.env.CHANNEL_WHATSAPP_LIMIT;
    try {
      expect(await whatsappUsage(prisma, "ws1")).toEqual({ used: 1, limit: 1, plan: "free" });
      const err = await assertWhatsappCapacity(prisma, "ws1").catch((e) => e);
      expect(err.getStatus()).toBe(409);
      expect(channelErrorKey(err)).toBe("channels.limit_reached");
      expect(err.getResponse()).toMatchObject({ limit: 1, plan: "free" });
      prisma.db.workspace[0].plan = "growth";
      await expect(assertWhatsappCapacity(prisma, "ws1")).resolves.toBeUndefined();
    } finally {
      if (prev !== undefined) process.env.CHANNEL_WHATSAPP_LIMIT = prev;
    }
  });
});
