import * as crypto from "node:crypto";
import { makeFakePrisma } from "../channels/test-prisma";
import { AiReplyController } from "../integrations/ai-reply.controller";
import { LOutboundService } from "../integrations/l-outbound.service";
import type { ZernioService } from "../integrations/zernio.service";
import { UsageService } from "./usage.service";

/**
 * SP-28 (R6): every AI reply is metered once per source, after the reply was
 * delivered, and metering never fails the reply.
 */
const WS = "ws1";
const SECRET = "test-secret";

function aiReplyController(usage: UsageService) {
  const prisma = {
    conversation: {
      findFirst: jest.fn(async () => ({ id: "c1", contactId: "ct1", aiEnabled: true, aiPausedAt: null, channel: "whatsapp" })),
    },
    message: {
      findFirst: jest.fn(async () => ({ createdAt: new Date(Date.now() - 3_600_000) })),
      create: jest.fn(async (a: any) => a.data),
    },
    integration: { findFirst: jest.fn(async () => null) },
  } as any;
  const whatsapp = { sendInConversation: jest.fn(async () => undefined) } as any;
  return {
    whatsapp,
    ctrl: new AiReplyController(
      prisma,
      whatsapp,
      { verifyInboundSignature: jest.fn(() => true) } as any,
      { emitToWorkspace: jest.fn() } as any,
      { onOutboundReply: jest.fn(), onAiStageSuggestion: jest.fn() } as any,
      { sendInDbConversation: jest.fn() } as unknown as ZernioService,
      { isLocked: jest.fn(async () => false) } as never,
      { effectiveChannel: jest.fn(async () => null) } as never,
      usage,
    ),
  };
}

function signed(body: unknown) {
  const raw = JSON.stringify(body);
  return { sig: crypto.createHmac("sha256", SECRET).update(raw).digest("hex"), req: { rawBody: Buffer.from(raw) } as never };
}

describe("SP-28 usage hooks", () => {
  beforeEach(() => {
    process.env.KEWY_AI_WEBHOOK_SECRET = SECRET;
  });

  it("usage recorded once per message", async () => {
    const meter = makeFakePrisma({ usageEvent: [] });
    const usage = new UsageService(meter as never);
    const { ctrl } = aiReplyController(usage);
    const p = { workspaceId: WS, conversationId: "c1", body: "hello", send: true };
    const { sig, req } = signed(p);
    // kewy-ai retries the same signed webhook: one usage event.
    expect(await ctrl.reply(req, sig, p as never)).toMatchObject({ delivered: true });
    expect(await ctrl.reply(req, sig, p as never)).toMatchObject({ delivered: true });
    const rows = (meter.db as any).usageEvent;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workspaceId: WS, meter: "ai_reply", sourceKind: "kewy_ai_reply" });
    // A different reply is a second event; a shadow (undelivered) one is none.
    const q = { ...p, body: "second" };
    const s2 = signed(q);
    await ctrl.reply(s2.req, s2.sig, q as never);
    const shadow = { ...p, body: "draft", send: false };
    const s3 = signed(shadow);
    expect(await ctrl.reply(s3.req, s3.sig, shadow as never)).toMatchObject({ delivered: false, reason: "shadow_mode" });
    expect(rows).toHaveLength(2);
  });

  it("usage failure does not fail the ai reply", async () => {
    const meter = makeFakePrisma({ usageEvent: [] });
    (meter as any).usageEvent.create = jest.fn(async () => {
      throw new Error("db unavailable");
    });
    const { ctrl, whatsapp } = aiReplyController(new UsageService(meter as never));
    const p = { workspaceId: WS, conversationId: "c1", body: "hello", send: true };
    const { sig, req } = signed(p);
    await expect(ctrl.reply(req, sig, p as never)).resolves.toMatchObject({ delivered: true });
    expect(whatsapp.sendInConversation).toHaveBeenCalledTimes(1);
  });

  it("the l path meters its stored AI message by id", async () => {
    const meter = makeFakePrisma({ usageEvent: [] });
    const usage = new UsageService(meter as never);
    const record = jest.spyOn(usage, "record");
    const prisma = {
      conversation: {
        findFirst: jest.fn(async () => ({ id: "c1", channel: "whatsapp", lConversationId: "lc1" })),
        update: jest.fn(async () => ({})),
      },
      message: { create: jest.fn(async () => ({ id: "msg-1" })) },
    } as any;
    const agent = { enabled: true, ask: jest.fn(async () => ({ answer: "hi", imageUrl: null })) };
    const svc = new LOutboundService(prisma, { emitToWorkspace: jest.fn() } as never, agent as never, usage);
    await svc.forwardReply(WS, "c1", "hello");
    expect(record).toHaveBeenCalledWith(WS, { meter: "ai_reply", sourceKind: "message", sourceId: "msg-1" });
    expect((meter.db as any).usageEvent).toHaveLength(1);
  });
});
