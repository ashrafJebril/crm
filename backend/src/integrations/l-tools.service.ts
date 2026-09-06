import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { LAgentResolverService } from "./l-agent-resolver.service";
import { LJoteckClient } from "./l-joteck.client";

export interface LTool {
  id: string;
  name: string;
  description: string;
  method: string;
  url_template: string;
  enabled: boolean;
  created_at: string;
  params: string[];
}

export interface CreateLToolInput {
  name: string;
  description: string;
  method: string;
  url_template: string;
  headers?: Record<string, string>;
  body_template?: Record<string, unknown> | null;
  param_descriptions?: Record<string, string>;
}

@Injectable()
export class LToolsService {
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

  async list(workspaceId: string): Promise<{ connected: boolean; tools: LTool[] }> {
    const lWorkspaceId = await this.requireLWorkspaceId(workspaceId);
    if (!lWorkspaceId) return { connected: false, tools: [] };
    const tools = await this.client.request<LTool[]>(`/workspaces/${lWorkspaceId}/tools`);
    return { connected: true, tools };
  }

  async create(workspaceId: string, input: CreateLToolInput): Promise<LTool> {
    const lWorkspaceId = await this.requireLWorkspaceId(workspaceId);
    if (!lWorkspaceId) throw new ServiceUnavailableException("Workspace is not connected to Kewy");
    return this.client.request<LTool>(`/workspaces/${lWorkspaceId}/tools`, { method: "POST", body: input });
  }

  async remove(workspaceId: string, toolId: string): Promise<void> {
    const lWorkspaceId = await this.requireLWorkspaceId(workspaceId);
    if (!lWorkspaceId) throw new ServiceUnavailableException("Workspace is not connected to Kewy");
    await this.client.request<void>(`/workspaces/${lWorkspaceId}/tools/${toolId}`, { method: "DELETE" });
  }

  async bind(workspaceId: string, toolId: string): Promise<void> {
    const lWorkspaceId = await this.requireLWorkspaceId(workspaceId);
    if (!lWorkspaceId) throw new ServiceUnavailableException("Workspace is not connected to Kewy");
    const slug = await this.resolver.resolveSlug(workspaceId, lWorkspaceId);
    await this.client.request<void>(
      `/workspaces/${lWorkspaceId}/agents/${slug}/tools/${toolId}`, { method: "PUT" },
    );
  }

  async unbind(workspaceId: string, toolId: string): Promise<void> {
    const lWorkspaceId = await this.requireLWorkspaceId(workspaceId);
    if (!lWorkspaceId) throw new ServiceUnavailableException("Workspace is not connected to Kewy");
    const slug = await this.resolver.resolveSlug(workspaceId, lWorkspaceId);
    await this.client.request<void>(
      `/workspaces/${lWorkspaceId}/agents/${slug}/tools/${toolId}`, { method: "DELETE" },
    );
  }
}
