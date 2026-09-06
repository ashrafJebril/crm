import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { LAgentResolverService } from "./l-agent-resolver.service";
import { LJoteckClient } from "./l-joteck.client";

export interface LMcpServer {
  id: string;
  name: string;
  description: string;
  url: string;
  enabled: boolean;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface LMcpTestResult {
  ok: boolean;
  tools: string[];
  error: string | null;
}

export interface CreateLMcpServerInput {
  name: string;
  description: string;
  url: string;
  headers?: Record<string, string>;
}

@Injectable()
export class LMcpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly client: LJoteckClient,
    private readonly resolver: LAgentResolverService,
  ) {}

  private async requireLWorkspaceId(workspaceId: string): Promise<string | null> {
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { lWorkspaceId: true },
    });
    return ws?.lWorkspaceId ?? null;
  }

  async list(workspaceId: string): Promise<{ connected: boolean; servers: LMcpServer[] }> {
    const lWorkspaceId = await this.requireLWorkspaceId(workspaceId);
    if (!lWorkspaceId) return { connected: false, servers: [] };
    const servers = await this.client.request<LMcpServer[]>(`/workspaces/${lWorkspaceId}/mcp-servers`);
    return { connected: true, servers };
  }

  async create(workspaceId: string, input: CreateLMcpServerInput): Promise<LMcpServer> {
    const lWorkspaceId = await this.requireLWorkspaceId(workspaceId);
    if (!lWorkspaceId) throw new ServiceUnavailableException("Workspace is not connected to Kewy");
    return this.client.request<LMcpServer>(`/workspaces/${lWorkspaceId}/mcp-servers`, {
      method: "POST",
      body: input,
    });
  }

  async remove(workspaceId: string, serverId: string): Promise<void> {
    const lWorkspaceId = await this.requireLWorkspaceId(workspaceId);
    if (!lWorkspaceId) throw new ServiceUnavailableException("Workspace is not connected to Kewy");
    await this.client.request<void>(`/workspaces/${lWorkspaceId}/mcp-servers/${serverId}`, {
      method: "DELETE",
    });
  }

  async bind(workspaceId: string, serverId: string): Promise<void> {
    const lWorkspaceId = await this.requireLWorkspaceId(workspaceId);
    if (!lWorkspaceId) throw new ServiceUnavailableException("Workspace is not connected to Kewy");
    const slug = await this.resolver.resolveSlug(workspaceId, lWorkspaceId);
    await this.client.request<void>(
      `/workspaces/${lWorkspaceId}/agents/${slug}/mcp-servers/${serverId}`, { method: "PUT" },
    );
  }

  async unbind(workspaceId: string, serverId: string): Promise<void> {
    const lWorkspaceId = await this.requireLWorkspaceId(workspaceId);
    if (!lWorkspaceId) throw new ServiceUnavailableException("Workspace is not connected to Kewy");
    const slug = await this.resolver.resolveSlug(workspaceId, lWorkspaceId);
    await this.client.request<void>(
      `/workspaces/${lWorkspaceId}/agents/${slug}/mcp-servers/${serverId}`, { method: "DELETE" },
    );
  }

  async test(workspaceId: string, serverId: string): Promise<LMcpTestResult> {
    const lWorkspaceId = await this.requireLWorkspaceId(workspaceId);
    if (!lWorkspaceId) throw new ServiceUnavailableException("Workspace is not connected to Kewy");
    return this.client.request<LMcpTestResult>(
      `/workspaces/${lWorkspaceId}/mcp-servers/${serverId}/test`, { method: "POST" },
    );
  }
}
