import { Test } from "@nestjs/testing";
import * as bcrypt from "bcryptjs";
import { McpTokenService } from "./mcp-token.service";
import { PrismaService } from "../prisma/prisma.service";

describe("McpTokenService", () => {
  let svc: McpTokenService;
  let prisma: { workspace: { findUnique: jest.Mock; update: jest.Mock } };

  beforeEach(async () => {
    prisma = { workspace: { findUnique: jest.fn(), update: jest.fn() } };
    const moduleRef = await Test.createTestingModule({
      providers: [McpTokenService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    svc = moduleRef.get(McpTokenService);
  });

  it("reports not connected when no prefix is set", async () => {
    prisma.workspace.findUnique.mockResolvedValue({ mcpTokenPrefix: null, mcpTokenCreatedAt: null });
    await expect(svc.status("ws1")).resolves.toEqual({ connected: false });
  });

  it("reports connected with the prefix and ISO creation date", async () => {
    const createdAt = new Date("2026-09-17T00:00:00.000Z");
    prisma.workspace.findUnique.mockResolvedValue({ mcpTokenPrefix: "abc123abc123", mcpTokenCreatedAt: createdAt });
    await expect(svc.status("ws1")).resolves.toEqual({
      connected: true,
      prefix: "abc123abc123",
      createdAt: "2026-09-17T00:00:00.000Z",
    });
  });

  it("generates a token, stores its bcrypt hash and prefix, and returns the plaintext once", async () => {
    const { token, endpointUrl } = await svc.generate("ws1");
    expect(token).toMatch(/^mcp_[0-9a-f]{12}_[A-Za-z0-9_-]+$/);
    expect(endpointUrl).toContain("/api/mcp/v1");
    const [{ where, data }] = prisma.workspace.update.mock.calls[0];
    expect(where).toEqual({ id: "ws1" });
    expect(data.mcpTokenPrefix).toBe(token.split("_")[1]);
    expect(data.mcpTokenCreatedAt).toBeInstanceOf(Date);
    await expect(bcrypt.compare(token, data.mcpTokenHash)).resolves.toBe(true);
  });

  it("revokes by clearing prefix, hash, and createdAt", async () => {
    await svc.revoke("ws1");
    expect(prisma.workspace.update).toHaveBeenCalledWith({
      where: { id: "ws1" },
      data: { mcpTokenPrefix: null, mcpTokenHash: null, mcpTokenCreatedAt: null },
    });
  });

  it("finds the owning workspace for a valid token", async () => {
    const { token } = await svc.generate("ws1");
    const { data } = prisma.workspace.update.mock.calls[0][0];
    prisma.workspace.findUnique.mockResolvedValue({ id: "ws1", mcpTokenHash: data.mcpTokenHash });

    await expect(svc.findWorkspaceByToken(token)).resolves.toBe("ws1");
    expect(prisma.workspace.findUnique).toHaveBeenCalledWith({
      where: { mcpTokenPrefix: data.mcpTokenPrefix },
      select: { id: true, mcpTokenHash: true },
    });
  });

  it("rejects a malformed token without touching the database", async () => {
    await expect(svc.findWorkspaceByToken("not-a-token")).resolves.toBeNull();
    expect(prisma.workspace.findUnique).not.toHaveBeenCalled();
  });

  it("rejects an unknown prefix", async () => {
    prisma.workspace.findUnique.mockResolvedValue(null);
    await expect(svc.findWorkspaceByToken("mcp_deadbeef1234_secret")).resolves.toBeNull();
  });

  it("rejects a wrong secret for a known prefix", async () => {
    const otherHash = await bcrypt.hash("mcp_deadbeef1234_othersecret", 10);
    prisma.workspace.findUnique.mockResolvedValue({ id: "ws1", mcpTokenHash: otherHash });
    await expect(svc.findWorkspaceByToken("mcp_deadbeef1234_wrongsecret")).resolves.toBeNull();
  });
});
