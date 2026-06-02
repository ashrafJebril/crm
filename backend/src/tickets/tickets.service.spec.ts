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

describe("TicketsService.updateTicket", () => {
  let svc: TicketsService;
  let prisma: any;
  let realtime: { emitToWorkspace: jest.Mock };

  beforeEach(async () => {
    prisma = {
      ticket: {
        findFirst: jest.fn().mockResolvedValue({ id: "tk_1", value: 100, ownerId: "u_1" }),
        update: jest.fn().mockResolvedValue({ id: "tk_1", value: 200, ownerId: "u_1" }),
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

  it("emits ticket.updated after successful update", async () => {
    await svc.updateTicket("ws_1", "tk_1", { value: 200 });
    expect(realtime.emitToWorkspace).toHaveBeenCalledWith(
      "ws_1",
      "ticket.updated",
      expect.objectContaining({ ticket: expect.objectContaining({ id: "tk_1", value: 200 }) }),
    );
  });
});

describe("TicketsService.createFromConversation", () => {
  let svc: TicketsService;
  let prisma: any;
  let realtime: { emitToWorkspace: jest.Mock };

  beforeEach(async () => {
    prisma = {
      conversation: {
        findFirst: jest.fn().mockResolvedValue({ id: "conv_1", contactId: "ct_99", workspaceId: "ws_1" }),
      },
      ticketStage: { findFirst: jest.fn().mockResolvedValue({ id: "st_1", pipelineId: "pl_1", key: "new" }) },
      ticket: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: "tk_new",
          number: 1,
          contactId: "ct_99",
          conversationId: "conv_1",
          pipelineId: "pl_1",
          stageId: "st_1",
        }),
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

  it("resolves contactId from the conversation and creates the ticket", async () => {
    const result = await svc.createFromConversation("ws_1", "conv_1", {
      pipelineId: "pl_1",
      stageId: "st_1",
      title: "Lead from chat",
    });
    expect(prisma.conversation.findFirst).toHaveBeenCalledWith({
      where: { id: "conv_1", workspaceId: "ws_1" },
    });
    expect(prisma.ticket.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          contactId: "ct_99",
          conversationId: "conv_1",
          title: "Lead from chat",
        }),
      }),
    );
    expect(realtime.emitToWorkspace).toHaveBeenCalledWith(
      "ws_1",
      "ticket.created",
      expect.objectContaining({ ticket: expect.objectContaining({ id: "tk_new" }) }),
    );
    expect(result).toEqual(expect.objectContaining({ id: "tk_new" }));
  });

  it("throws NotFoundException when conversation does not exist", async () => {
    prisma.conversation.findFirst.mockResolvedValueOnce(null);
    await expect(
      svc.createFromConversation("ws_1", "missing", {
        pipelineId: "pl_1",
        stageId: "st_1",
        title: "x",
      }),
    ).rejects.toThrow("Conversation not found");
  });
});
