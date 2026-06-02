import { Test } from "@nestjs/testing";
import { TicketsService } from "./tickets.service";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeService } from "../realtime/realtime.service";

describe("TicketsService.listTickets", () => {
  let svc: TicketsService;
  let prisma: { ticket: { findMany: jest.Mock } };

  beforeEach(async () => {
    prisma = { ticket: { findMany: jest.fn().mockResolvedValue([]) } };
    const moduleRef = await Test.createTestingModule({
      providers: [
        TicketsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RealtimeService, useValue: { emitToWorkspace: jest.fn() } },
      ],
    }).compile();
    svc = moduleRef.get(TicketsService);
  });

  it("filters by conversationId when provided", async () => {
    await svc.listTickets("ws_1", { conversationId: "conv_42" });
    expect(prisma.ticket.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: "ws_1",
          conversationId: "conv_42",
        }),
      }),
    );
  });
});
