import { Test } from "@nestjs/testing";
import { LAgentService, LTryTurnError } from "./l-agent.service";
import { PrismaService } from "../prisma/prisma.service";

describe("LAgentService.ask", () => {
  let svc: LAgentService;
  let prisma: any;
  let fetchMock: jest.Mock;

  beforeEach(async () => {
    process.env.L_API_URL = "http://l.test/";
    prisma = {
      workspace: {
        findUnique: jest.fn().mockResolvedValue({
          lEndpointId: "endpoint-1",
          lEndpointSecret: "sekret",
        }),
      },
    };
    fetchMock = jest.fn();
    global.fetch = fetchMock as any;

    const moduleRef = await Test.createTestingModule({
      providers: [LAgentService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    svc = moduleRef.get(LAgentService);
  });

  afterEach(() => {
    delete process.env.L_API_URL;
    jest.restoreAllMocks();
  });

  it("returns the answer and the image url when l provides both", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ answer: "here", citations: [], image_url: "https://example.com/pic.png" }),
    });

    const result = await svc.ask("ws-1", { externalId: "c1", message: "show me" });

    expect(result).toEqual({ answer: "here", imageUrl: "https://example.com/pic.png" });
  });

  it("omits imageUrl when l returns none", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ answer: "here", citations: [] }),
    });

    const result = await svc.ask("ws-1", { externalId: "c1", message: "hello" });

    expect(result).toEqual({ answer: "here", imageUrl: undefined });
  });

  it("omits imageUrl when l returns null for it", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ answer: "here", citations: [], image_url: null }),
    });

    const result = await svc.ask("ws-1", { externalId: "c1", message: "hello" });

    expect(result).toEqual({ answer: "here", imageUrl: undefined });
  });

  it("still returns null when l gives no answer", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });

    const result = await svc.ask("ws-1", { externalId: "c1", message: "hello" });

    expect(result).toBeNull();
  });
});

describe("LAgentService.tryTurn", () => {
  let svc: LAgentService;
  let prisma: any;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env.L_API_URL = "http://l.test/";
    prisma = {
      workspace: { findUnique: jest.fn().mockResolvedValue({ lEndpointId: "endpoint-1", lEndpointSecret: "sekret" }) },
    };
    fetchMock = jest.fn();
    global.fetch = fetchMock as any;
    svc = new LAgentService(prisma as PrismaService);
  });

  afterEach(() => {
    delete process.env.L_API_URL;
    jest.restoreAllMocks();
  });

  const turn = (history: { role: "user" | "assistant"; content: string }[] = []) =>
    svc.tryTurn("ws-1", { message: "and tomorrow?", history, timeoutMs: 1000 });

  it("asks l for a dry run with our history and returns its tool calls", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        answer: "Open 9-5.",
        citations: ["hours.md"],
        tool_calls: [{ name: "kewy_crm_find_slots", args: { date: "2026-11-26" } }],
      }),
    });

    const result = await turn([
      { role: "user", content: "open today?" },
      { role: "assistant", content: "Yes." },
    ]);

    expect(result).toEqual({
      answer: "Open 9-5.",
      citations: ["hours.md"],
      toolCalls: [{ name: "kewy_crm_find_slots", args: { date: "2026-11-26" } }],
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://l.test/api/v1/webhooks/endpoint-1/messages");
    expect(init.headers["x-webhook-secret"]).toBe("sekret");
    expect(JSON.parse(init.body)).toEqual({
      external_id: "try-your-agent",
      message: "and tomorrow?",
      dry_run: true,
      history: [
        { role: "user", content: "open today?" },
        { role: "assistant", content: "Yes." },
      ],
    });
  });

  it("drops empty turns and keeps only the last 50", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ answer: "ok" }) });
    const many = Array.from({ length: 60 }, (_, i) => ({ role: "user" as const, content: `m${i}` }));

    await turn([{ role: "user", content: "  " }, ...many]);

    const sent = JSON.parse(fetchMock.mock.calls[0][1].body).history;
    expect(sent).toHaveLength(50);
    expect(sent[0].content).toBe("m10");
  });

  it("is null when the workspace is not linked to l", async () => {
    prisma.workspace.findUnique.mockResolvedValue({ lEndpointId: null, lEndpointSecret: null });
    await expect(turn()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is null when no l platform is configured", async () => {
    delete process.env.L_API_URL;
    await expect(turn()).resolves.toBeNull();
  });

  it.each([
    ["an error status", () => fetchMock.mockResolvedValue({ ok: false, status: 502, json: async () => ({}) })],
    ["no answer", () => fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ citations: [] }) })],
    ["an unreachable platform", () => fetchMock.mockRejectedValue(new Error("ECONNREFUSED"))],
  ])("throws on %s", async (_label, arrange) => {
    arrange();
    await expect(turn()).rejects.toBeInstanceOf(LTryTurnError);
  });
});
