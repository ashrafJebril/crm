import { ZernioService } from "./zernio.service";
import { AiReplyController } from "./ai-reply.controller";
import * as crypto from "node:crypto";

/**
 * The 24-hour window is a Meta rule, not ours: outside it, a free-text send is
 * rejected. The bridge reports the window as open when the customer's message
 * ARRIVES, which is true then — but an agent turn takes 5-20s and a retried or
 * queued turn can land much later. Re-checking at send time is what stops a
 * reply from vanishing silently.
 */
describe("AiReplyController — 24h window re-check", () => {
  const WS = "ws1";
  const SECRET = "test-secret";
  const HOUR = 60 * 60 * 1000;

  function build(opts: { lastInboundAgoMs: number | null; channel?: string }) {
    const created: any[] = [];
    const sent: any[] = [];
    const prisma = {
      conversation: {
        findFirst: jest.fn(async () => ({
          id: "c1",
          contactId: "ct1",
          aiEnabled: true,
          aiPausedAt: null,
          channel: opts.channel ?? "whatsapp",
        })),
      },
      message: {
        findFirst: jest.fn(async () =>
          opts.lastInboundAgoMs === null
            ? null
            : { createdAt: new Date(Date.now() - opts.lastInboundAgoMs) },
        ),
        create: jest.fn(async (args: any) => {
          created.push(args.data);
          return args.data;
        }),
      },
      // The send path picks a transport from the thread's integration row.
      // null = no row, which falls back to the direct-Meta WhatsAppService —
      // the transport these window tests assert against.
      integration: {
        findFirst: jest.fn(async () => null),
      },
    } as any;
    const whatsapp = {
      sendInConversation: jest.fn(async (...a: unknown[]) => {
        sent.push(a);
      }),
    } as any;
    const realtime = { emitToWorkspace: jest.fn() } as any;
    const pipeline = { onOutboundReply: jest.fn(), onAiStageSuggestion: jest.fn() } as any;
    const bridge = { verifyInboundSignature: jest.fn(() => true) } as any;
    const ctrl = new AiReplyController(
      prisma,
      whatsapp,
      bridge,
      realtime,
      pipeline,
      { sendInDbConversation: jest.fn() } as unknown as ZernioService,
    );
    return { ctrl, created, sent, whatsapp };
  }

  function signed(body: unknown) {
    const raw = JSON.stringify(body);
    return {
      raw,
      sig: crypto.createHmac("sha256", SECRET).update(raw).digest("hex"),
      req: { rawBody: Buffer.from(raw) } as never,
    };
  }

  const payload = (over: Record<string, unknown> = {}) => ({
    workspaceId: WS,
    conversationId: "c1",
    body: "أهلا فيكي",
    send: true,
    ...over,
  });

  beforeEach(() => {
    process.env.KEWY_AI_WEBHOOK_SECRET = SECRET;
  });

  it("SENDS when the customer messaged 2 hours ago — window open", async () => {
    const { ctrl, sent } = build({ lastInboundAgoMs: 2 * HOUR });
    const p = payload();
    const { sig, req } = signed(p);
    const res = await ctrl.reply(req, sig, p as never);
    expect(sent).toHaveLength(1);
    expect(res).toMatchObject({ delivered: true });
  });

  // The exact failure this guards: turn queued, retried, and by the time the
  // reply comes back Meta will not accept free text any more.
  it("does NOT send when the last inbound was 25 hours ago", async () => {
    const { ctrl, sent, created } = build({ lastInboundAgoMs: 25 * HOUR });
    const p = payload();
    const { sig, req } = signed(p);
    const res = await ctrl.reply(req, sig, p as never);
    expect(sent).toHaveLength(0);
    expect(res).toMatchObject({ delivered: false, reason: "window_closed", logged: true });
  });

  // Silence is the worst outcome: staff must see the draft and be able to act.
  it("stores the undelivered reply so a human can send it as a template", async () => {
    const { ctrl, created } = build({ lastInboundAgoMs: 25 * HOUR });
    const p = payload();
    const { sig, req } = signed(p);
    await ctrl.reply(req, sig, p as never);
    expect(created).toHaveLength(1);
    expect(created[0].from).toBe("ai");
    expect(created[0].agent).toContain("window closed");
    expect(created[0].body).toBe("أهلا فيكي");
  });

  it("treats a conversation with no inbound message as closed — fail safe", async () => {
    const { ctrl, sent } = build({ lastInboundAgoMs: null });
    const p = payload();
    const { sig, req } = signed(p);
    const res = await ctrl.reply(req, sig, p as never);
    expect(sent).toHaveLength(0);
    expect(res).toMatchObject({ reason: "window_closed" });
  });

  // The rule is Meta's. Other transports must not inherit it.
  it("does not apply the window to a non-WhatsApp channel", async () => {
    const { ctrl, sent } = build({ lastInboundAgoMs: 25 * HOUR, channel: "instagram" });
    const p = payload();
    const { sig, req } = signed(p);
    await ctrl.reply(req, sig, p as never);
    expect(sent).toHaveLength(1);
  });

  it("shadow mode never reaches the window check at all", async () => {
    const { ctrl, sent, created } = build({ lastInboundAgoMs: 25 * HOUR });
    const p = payload({ send: false });
    const { sig, req } = signed(p);
    const res = await ctrl.reply(req, sig, p as never);
    expect(sent).toHaveLength(0);
    expect(res).toMatchObject({ reason: "shadow_mode" });
    expect(created[0].agent).toContain("shadow");
  });
});
