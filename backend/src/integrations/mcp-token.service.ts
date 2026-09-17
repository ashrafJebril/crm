import { Injectable } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import * as crypto from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";

export interface McpTokenStatus {
  connected: boolean;
  prefix?: string;
  createdAt?: string;
}

@Injectable()
export class McpTokenService {
  constructor(private readonly prisma: PrismaService) {}

  async status(workspaceId: string): Promise<McpTokenStatus> {
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { mcpTokenPrefix: true, mcpTokenCreatedAt: true },
    });
    if (!ws?.mcpTokenPrefix) return { connected: false };
    return {
      connected: true,
      prefix: ws.mcpTokenPrefix,
      createdAt: ws.mcpTokenCreatedAt?.toISOString(),
    };
  }

  async generate(workspaceId: string): Promise<{ token: string; endpointUrl: string }> {
    const prefix = crypto.randomBytes(6).toString("hex");
    const secret = crypto.randomBytes(32).toString("base64url");
    const token = `mcp_${prefix}_${secret}`;
    const mcpTokenHash = await bcrypt.hash(token, 10);
    await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: { mcpTokenPrefix: prefix, mcpTokenHash, mcpTokenCreatedAt: new Date() },
    });
    const base = process.env.BACKEND_PUBLIC_URL ?? "http://localhost:4100";
    return { token, endpointUrl: `${base}/api/mcp/v1` };
  }

  async revoke(workspaceId: string): Promise<void> {
    await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: { mcpTokenPrefix: null, mcpTokenHash: null, mcpTokenCreatedAt: null },
    });
  }

  /** Returns the owning workspace id for a valid, non-revoked token, else null. */
  async findWorkspaceByToken(token: string): Promise<string | null> {
    const match = token.match(/^mcp_([0-9a-f]{12})_(.+)$/);
    if (!match) return null;
    const [, prefix] = match;
    const ws = await this.prisma.workspace.findUnique({
      where: { mcpTokenPrefix: prefix },
      select: { id: true, mcpTokenHash: true },
    });
    if (!ws?.mcpTokenHash) return null;
    const ok = await bcrypt.compare(token, ws.mcpTokenHash);
    return ok ? ws.id : null;
  }
}
