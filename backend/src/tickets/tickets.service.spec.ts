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

describe("TicketsService.createTicket", () => {
  let svc: TicketsService;
  let prisma: any;
  let realtime: { emitToWorkspace: jest.Mock };

  beforeEach(async () => {
    prisma = {
      ticketStage: { findFirst: jest.fn().mockResolvedValue({ id: "st_1", pipelineId: "pl_1", key: "new" }) },
      ticket: {
        findFirst: jest.fn().mockResolvedValue({ number: 4 }),
        create: jest.fn().mockResolvedValue({ id: "tk_1", number: 5, stageId: "st_1", pipelineId: "pl_1" }),
      },
      ticketActivity: { create: jest.fn().mockResolvedValue({}) },
    };
    realtime = { emitToWorkspace: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        TicketsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RealtimeService, useValue: realtime },
      ],
    }).compile();
    svc = moduleRef.get(TicketsService);
  });

  it("emits ticket.created after successful insert", async () => {
    await svc.createTicket("ws_1", {
      pipelineId: "pl_1",
      stageId: "st_1",
      contactId: "ct_1",
      title: "Test",
    });
    expect(realtime.emitToWorkspace).toHaveBeenCalledWith(
      "ws_1",
      "ticket.created",
      expect.objectContaining({ ticket: expect.objectContaining({ id: "tk_1" }) }),
    );
  });
});
