import { Test } from "@nestjs/testing";
import { LAgentService } from "./l-agent.service";
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
