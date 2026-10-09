import { ServiceUnavailableException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { LKnowledgeService } from "./l-knowledge.service";
import { LJoteckClient } from "./l-joteck.client";
import { PrismaService } from "../prisma/prisma.service";

const DOC = {
  id: "doc-1", title: "notes.txt", source_type: "upload", status: "ready",
  meta: {}, created_at: "2026-09-06T00:00:00Z",
};

describe("LKnowledgeService", () => {
  let svc: LKnowledgeService;
  let prisma: any;
  let client: any;

  beforeEach(async () => {
    prisma = { workspace: { findUnique: jest.fn().mockResolvedValue({ lWorkspaceId: "l-ws-1" }) } };
    client = { request: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        LKnowledgeService,
        { provide: PrismaService, useValue: prisma },
        { provide: LJoteckClient, useValue: client },
      ],
    }).compile();
    svc = moduleRef.get(LKnowledgeService);
  });

  it("lists documents for a connected workspace", async () => {
    client.request.mockResolvedValue([DOC]);
    const result = await svc.list("ws-1");
    expect(result).toEqual({ connected: true, documents: [DOC] });
    expect(client.request).toHaveBeenCalledWith("/workspaces/l-ws-1/documents");
  });

  it("returns connected:false without calling the platform when unlinked", async () => {
    prisma.workspace.findUnique.mockResolvedValue({ lWorkspaceId: null });
    const result = await svc.list("ws-1");
    expect(result).toEqual({ connected: false, documents: [] });
    expect(client.request).not.toHaveBeenCalled();
  });

  it("uploads a file as multipart form data", async () => {
    client.request.mockResolvedValue(DOC);
    const file = { buffer: Buffer.from("hello"), originalname: "notes.txt" } as Express.Multer.File;

    const result = await svc.upload("ws-1", file);

    expect(result).toEqual(DOC);
    const [path, opts] = client.request.mock.calls[0];
    expect(path).toBe("/workspaces/l-ws-1/documents");
    expect(opts.method).toBe("POST");
    expect(opts.formData).toBeInstanceOf(FormData);
  });

  it("throws when uploading to an unlinked workspace", async () => {
    prisma.workspace.findUnique.mockResolvedValue({ lWorkspaceId: null });
    const file = { buffer: Buffer.from("hello"), originalname: "x.txt" } as Express.Multer.File;
    await expect(svc.upload("ws-1", file)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("deletes a document by id", async () => {
    client.request.mockResolvedValue(undefined);
    await svc.remove("ws-1", "doc-1");
    expect(client.request).toHaveBeenCalledWith("/workspaces/l-ws-1/documents/doc-1", { method: "DELETE" });
  });
});
