import { Test } from "@nestjs/testing";
import { LAgentResolverService } from "./l-agent-resolver.service";
import { LJoteckClient } from "./l-joteck.client";
import { PrismaService } from "../prisma/prisma.service";

describe("LAgentResolverService.resolveSlug", () => {
  let svc: LAgentResolverService;
  let prisma: any;
  let client: any;

  beforeEach(async () => {
    prisma = {
      workspace: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    client = { request: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        LAgentResolverService,
        { provide: PrismaService, useValue: prisma },
        { provide: LJoteckClient, useValue: client },
      ],
    }).compile();
    svc = moduleRef.get(LAgentResolverService);
  });

  it("returns the cached slug without calling the platform", async () => {
    prisma.workspace.findUnique.mockResolvedValue({ lAgentSlug: "customer-support" });

    const slug = await svc.resolveSlug("ws-1", "l-ws-1");

    expect(slug).toBe("customer-support");
    expect(client.request).not.toHaveBeenCalled();
    expect(prisma.workspace.update).not.toHaveBeenCalled();
  });

  it("resolves via the default-agent endpoint and caches it when uncached", async () => {
    prisma.workspace.findUnique.mockResolvedValue({ lAgentSlug: null });
    client.request.mockResolvedValue({ slug: "customer-support" });

    const slug = await svc.resolveSlug("ws-1", "l-ws-1");

    expect(slug).toBe("customer-support");
    expect(client.request).toHaveBeenCalledWith("/workspaces/l-ws-1/agents/default", { method: "POST" });
    expect(prisma.workspace.update).toHaveBeenCalledWith({
      where: { id: "ws-1" },
      data: { lAgentSlug: "customer-support" },
    });
  });
});
