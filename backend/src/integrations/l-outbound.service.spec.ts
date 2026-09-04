import { Test } from "@nestjs/testing";
import { LOutboundService } from "./l-outbound.service";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeService } from "../realtime/realtime.service";

const CONV = {
  id: "conv-1",
  channel: "l",
  lConversationId: "l-session-1",
};

describe("LOutboundService.forwardReply", () => {
  let svc: LOutboundService;
  let prisma: any;
  let realtime: any;
  let fetchMock: jest.Mock;

  beforeEach(async () => {
    process.env.L_API_URL = "http://l.test/";
    prisma = {
      conversation: {
        findFirst: jest.fn().mockResolvedValue(CONV),
        update: jest.fn().mockResolvedValue({}),
      },
      workspace: {
        findUnique: jest.fn().mockResolvedValue({
          lEndpointId: "endpoint-1",
          lEndpointSecret: "sekret",
        }),
      },
      message: { create: jest.fn().mockResolvedValue({ id: "msg-1" }) },
    };
    realtime = { emitToWorkspace: jest.fn() };

    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ answer: "the agent replies", citations: [] }),
    });
    global.fetch = fetchMock as any;

    const moduleRef = await Test.createTestingModule({
      providers: [
        LOutboundService,
        { provide: PrismaService, useValue: prisma },
        { provide: RealtimeService, useValue: realtime },
      ],
    }).compile();
    svc = moduleRef.get(LOutboundService);
  });

  afterEach(() => {
    delete process.env.L_API_URL;
    jest.restoreAllMocks();
  });

  it("posts the reply to the workspace's l endpoint", async () => {
    await svc.forwardReply("ws-1", "conv-1", "a human replies");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    // The trailing slash on L_API_URL must not produce a double slash.
    expect(url).toBe("http://l.test/api/v1/webhooks/endpoint-1/messages");
    expect(init.headers["x-webhook-secret"]).toBe("sekret");
    expect(JSON.parse(init.body)).toEqual({
      external_id: "conv-1",
      message: "a human replies",
      // Continuing the existing l chat is the whole point; without this l
      // would open a second conversation nobody is watching.
      session_id: "l-session-1",
    });
  });

  it("stores the agent's answer and nudges the inbox", async () => {
    await svc.forwardReply("ws-1", "conv-1", "hello");

    expect(prisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          conversationId: "conv-1",
          workspaceId: "ws-1",
          from: "ai",
          body: "the agent replies",
        }),
      }),
    );
    // The inbox is already rendered by now, so it has to be told or the
    // answer sits unseen until a refresh.
    expect(realtime.emitToWorkspace).toHaveBeenCalledWith(
      "ws-1",
      "inbox.activity",
      { channel: "l", conversationId: "conv-1" },
    );
  });

  it("does not forward a conversation that did not come from l", async () => {
    prisma.conversation.findFirst.mockResolvedValue({
      id: "conv-2",
      channel: "whatsapp",
      lConversationId: null,
    });

    await svc.forwardReply("ws-1", "conv-2", "hello");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not forward when the workspace has no l endpoint configured", async () => {
    prisma.workspace.findUnique.mockResolvedValue({
      lEndpointId: null,
      lEndpointSecret: null,
    });

    await svc.forwardReply("ws-1", "conv-1", "hello");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing when L_API_URL is unset", async () => {
    delete process.env.L_API_URL;

    await svc.forwardReply("ws-1", "conv-1", "hello");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(prisma.conversation.findFirst).not.toHaveBeenCalled();
  });

  it("scopes the conversation lookup to the workspace", async () => {
    // A conversation id from another tenant must not resolve, or one
    // workspace could push messages into another's l chat.
    await svc.forwardReply("ws-1", "conv-1", "hello");

    expect(prisma.conversation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "conv-1", workspaceId: "ws-1" },
      }),
    );
  });

  it("writes nothing when l rejects the delivery", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });

    await svc.forwardReply("ws-1", "conv-1", "hello");

    expect(prisma.message.create).not.toHaveBeenCalled();
    expect(realtime.emitToWorkspace).not.toHaveBeenCalled();
  });

  it("writes nothing when l returns no answer", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });

    await svc.forwardReply("ws-1", "conv-1", "hello");

    expect(prisma.message.create).not.toHaveBeenCalled();
  });

  it("swallows an unreachable l rather than failing the caller", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    // The reply is already saved by the time we are called; a dead l must not
    // turn it into a failed request.
    await expect(svc.forwardReply("ws-1", "conv-1", "hello")).resolves.toBeUndefined();
    expect(prisma.message.create).not.toHaveBeenCalled();
  });

  it("queueReply returns before delivery completes and never throws", async () => {
    // Deferred up front: forwardReply awaits two Prisma reads before it ever
    // reaches fetch, so a resolver assigned inside the executor would still be
    // unset at the moment the test wants to release it.
    let release: (v: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    fetchMock.mockReturnValue(pending);

    expect(() => svc.queueReply("ws-1", "conv-1", "hello")).not.toThrow();
    // Nothing written yet — the inbox's POST did not wait on the model turn.
    expect(prisma.message.create).not.toHaveBeenCalled();

    release({ ok: true, status: 200, json: async () => ({ answer: "later" }) });
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    expect(prisma.message.create).toHaveBeenCalled();
  });
});
