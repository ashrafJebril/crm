import "reflect-metadata";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { SavedRepliesService } from "./saved-replies.service";
import { CreateSavedReplyDto } from "./saved-replies.dto";

const p2002 = () => Object.assign(new Error("unique"), { code: "P2002" });

function build() {
  const prisma = {
    savedReply: {
      findMany: jest.fn(async () => [{ id: "r1" }]),
      findFirst: jest.fn(async () => ({ id: "r1", workspaceId: "ws" })),
      create: jest.fn(async ({ data }: any) => ({ id: "r1", ...data })),
      update: jest.fn(async ({ data }: any) => ({ id: "r1", ...data })),
      delete: jest.fn(async () => ({})),
    },
  };
  return { prisma, svc: new SavedRepliesService(prisma as never) };
}

const dto = (o: Record<string, unknown>) =>
  plainToInstance(CreateSavedReplyDto, { title: "Hi", body: "Hello", shortcut: "hi", ...o });

describe("SavedRepliesService", () => {
  it("lists only the workspace replies", async () => {
    const { prisma, svc } = build();
    await svc.list("ws");
    expect((prisma.savedReply.findMany.mock.calls[0] as any)[0].where).toEqual({ workspaceId: "ws" });
  });

  it("creates scoped to the workspace", async () => {
    const { prisma, svc } = build();
    await svc.create("ws", dto({}));
    expect((prisma.savedReply.create.mock.calls[0] as any)[0].data).toMatchObject({ workspaceId: "ws", shortcut: "hi" });
  });

  it("maps a P2002 on create (concurrent duplicate shortcut) to 409 saved_replies.shortcut_exists", async () => {
    const { prisma, svc } = build();
    prisma.savedReply.create.mockRejectedValueOnce(p2002());
    await expect(svc.create("ws", dto({}))).rejects.toMatchObject({ message: "saved_replies.shortcut_exists" });
    prisma.savedReply.create.mockRejectedValueOnce(p2002());
    await expect(svc.create("ws", dto({}))).rejects.toBeInstanceOf(ConflictException);
  });

  it("maps P2002 on update to 409 and 404s a reply from another workspace", async () => {
    const { prisma, svc } = build();
    prisma.savedReply.update.mockRejectedValueOnce(p2002());
    await expect(svc.update("ws", "r1", { shortcut: "dup" })).rejects.toBeInstanceOf(ConflictException);
    prisma.savedReply.findFirst.mockResolvedValueOnce(null as never);
    await expect(svc.update("ws", "other", { title: "x" })).rejects.toBeInstanceOf(NotFoundException);
    prisma.savedReply.findFirst.mockResolvedValueOnce(null as never);
    await expect(svc.remove("ws", "other")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("removes an owned reply", async () => {
    const { prisma, svc } = build();
    await svc.remove("ws", "r1");
    expect((prisma.savedReply.delete.mock.calls[0] as any)[0].where).toEqual({ id: "r1" });
  });
});

describe("CreateSavedReplyDto", () => {
  it("accepts a valid shortcut and rejects bad ones", async () => {
    expect(await validate(dto({ shortcut: "a-b_9" }))).toHaveLength(0);
    for (const bad of ["", "Hi", "has space", "x".repeat(33), "اهلا"]) {
      expect((await validate(dto({ shortcut: bad }))).length).toBeGreaterThan(0);
    }
  });
  it("caps body at 4000 chars and allows optional bodyAr", async () => {
    expect(await validate(dto({ body: "x".repeat(4000), bodyAr: "مرحبا" }))).toHaveLength(0);
    expect((await validate(dto({ body: "x".repeat(4001) }))).length).toBeGreaterThan(0);
    expect((await validate(dto({ bodyAr: "x".repeat(4001) }))).length).toBeGreaterThan(0);
  });
});
