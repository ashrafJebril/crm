import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { LJoteckClient } from "./l-joteck.client";

interface LAgentResponse {
  slug: string;
}

/**
 * Resolves the l agent slug a workspace's tool/MCP-server bindings operate
 * on. Every CRM workspace maps to exactly one l agent in practice (there is
 * no multi-agent UI here) — this caches the slug on first resolve so a
 * bind/unbind call doesn't round-trip to l every time.
 */
@Injectable()
export class LAgentResolverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly client: LJoteckClient,
  ) {}

  async resolveSlug(workspaceId: string, lWorkspaceId: string): Promise<string> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { lAgentSlug: true },
    });
    if (workspace?.lAgentSlug) return workspace.lAgentSlug;

    const agent = await this.client.request<LAgentResponse>(
      `/workspaces/${lWorkspaceId}/agents/default`,
      { method: "POST" },
    );
    await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: { lAgentSlug: agent.slug },
    });
    return agent.slug;
  }
}
