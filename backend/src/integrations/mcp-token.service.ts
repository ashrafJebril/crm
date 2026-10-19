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
    return { token, endpointUrl: mcpEndpointUrl() };
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

/**
 * The URL Kewy AI (and anyone handed a token) calls this CRM's MCP server on.
 *
 * CRM_MCP_PUBLIC_URL is a Fly secret on kewy-marketing-api, set apart from
 * BACKEND_PUBLIC_URL so the MCP can move behind its own host without touching
 * media/webhook URLs; BACKEND_PUBLIC_URL stays as the fallback. The localhost
 * default is for local development only: registering it with Kewy AI in
 * production would leave the agent with tools it can never reach.
 */
export function mcpEndpointUrl(): string {
  const configured =
    process.env.CRM_MCP_PUBLIC_URL?.trim() || process.env.BACKEND_PUBLIC_URL?.trim();
  if (!configured && process.env.NODE_ENV === "production") {
    throw new Error("CRM_MCP_PUBLIC_URL is not configured");
  }
  const base = configured || "http://localhost:4100";
  return `${base.replace(/\/$/, "")}/api/mcp/v1`;
}
