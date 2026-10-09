import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AdminService } from "../admin/admin.service";
import type { ProvisionClientDto } from "../admin/admin.dto";
import { LAgentSetupService } from "../integrations/l-agent-setup.service";

@Injectable()
export class JoteckService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: AdminService,
    private readonly agentSetup: LAgentSetupService,
  ) {}

  /**
   * Create a workspace + owner for the Kewy admin console. Delegates to the
   * same routine the super-admin portal uses, then returns the workspace in
   * the same shape as list/get so callers can parse one format.
   */
  async provisionWorkspace(dto: ProvisionClientDto) {
    const { workspace } = await this.admin.provisionClient(dto);
    if (dto.lWorkspaceId) await this.agentSetup.ensureQuietly(workspace.id);
    return this.getWorkspace(workspace.id);
  }

  async listWorkspaces(q?: string) {
    const where: Record<string, unknown> = {};
    if (q) {
      where.OR = [
        { name: { contains: q, mode: "insensitive" } },
        { slug: { contains: q, mode: "insensitive" } },
      ];
    }
    // Cross-tenant read — bypass the tenancy extension via prisma.raw.
    const items = await this.prisma.raw.workspace.findMany({
      where,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        slug: true,
        name: true,
        plan: true,
        suspendedAt: true,
        externalTenantId: true,
        kewyWorkspaceId: true,
        lWorkspaceId: true,
        lang: true,
        timezone: true,
        enabledModules: true,
        createdAt: true,
      },
    });
    return items.map((w) => ({
      ...w,
      createdAt: w.createdAt.toISOString(),
      suspendedAt: w.suspendedAt ? w.suspendedAt.toISOString() : null,
      enabledModules: Array.isArray(w.enabledModules) ? (w.enabledModules as string[]) : null,
    }));
  }

  async getWorkspace(id: string) {
    const w = await this.prisma.raw.workspace.findUnique({
      where: { id },
      select: {
        id: true,
        slug: true,
        name: true,
        plan: true,
        suspendedAt: true,
        externalTenantId: true,
        kewyWorkspaceId: true,
        lWorkspaceId: true,
        lang: true,
        timezone: true,
        enabledModules: true,
        createdAt: true,
      },
    });
    if (!w) throw new NotFoundException("Workspace not found");
    return {
      ...w,
      createdAt: w.createdAt.toISOString(),
      suspendedAt: w.suspendedAt ? w.suspendedAt.toISOString() : null,
      enabledModules: Array.isArray(w.enabledModules) ? (w.enabledModules as string[]) : null,
    };
  }

  /** Explicit (re-)run of the agent wiring, e.g. to backfill already-linked workspaces. */
  setupAgent(id: string) {
    return this.agentSetup.ensure(id);
  }

  async stats(id: string) {
    const w = await this.prisma.raw.workspace.findUnique({
      where: { id },
      select: { suspendedAt: true },
    });
    if (!w) throw new NotFoundException("Workspace not found");

    const [contacts, conversations, tickets, campaigns, members] = await Promise.all([
      this.prisma.raw.contact.count({ where: { workspaceId: id } }).catch(() => 0),
      this.prisma.raw.conversation.count({ where: { workspaceId: id } }).catch(() => 0),
      this.prisma.raw.ticket.count({ where: { workspaceId: id } }).catch(() => 0),
      this.prisma.raw.campaign.count({ where: { workspaceId: id } }).catch(() => 0),
      this.prisma.raw.workspaceMember.count({ where: { workspaceId: id } }).catch(() => 0),
    ]);
    return {
      contacts,
      conversations,
      tickets,
      campaigns,
      members,
      active: !w.suspendedAt,
    };
  }

  async patchWorkspace(
    id: string,
    body: {
      active?: boolean;
      enabledModules?: string[];
      lWorkspaceId?: string | null;
      lEndpointId?: string | null;
      lEndpointSecret?: string | null;
    },
  ) {
    const data: Record<string, unknown> = {};
    // Links this crm workspace to its Kewy AI (`l`) workspace; null unlinks.
    if (body.lWorkspaceId !== undefined) {
      const lId = body.lWorkspaceId?.trim() || null;
      if (lId) {
        const taken = await this.prisma.raw.workspace.findUnique({
          where: { lWorkspaceId: lId },
          select: { id: true },
        });
        if (taken && taken.id !== id) {
          throw new ConflictException("That Kewy AI workspace is already linked to another workspace");
        }
      }
      data.lWorkspaceId = lId;
      // The cached agent slug belongs to the previous l workspace; keeping it
      // would point tool/MCP bindings at an agent that doesn't exist there.
      data.lAgentSlug = null;
    }
    // Webhook credentials l issued for this workspace's agent. The secret is
    // write-only: it is never included in any joteck response.
    if (body.lEndpointId !== undefined) data.lEndpointId = body.lEndpointId?.trim() || null;
    if (body.lEndpointSecret !== undefined) {
      data.lEndpointSecret = body.lEndpointSecret?.trim() || null;
    }
    if (typeof body.active === "boolean") {
      data.suspendedAt = body.active ? null : new Date();
    }
    if (Array.isArray(body.enabledModules)) {
      data.enabledModules = body.enabledModules;
    }
    const updated = await this.prisma.raw.workspace.update({
      where: { id },
      data,
      select: {
        id: true,
        slug: true,
        name: true,
        plan: true,
        suspendedAt: true,
        externalTenantId: true,
        kewyWorkspaceId: true,
        lWorkspaceId: true,
        lang: true,
        timezone: true,
        enabledModules: true,
        createdAt: true,
      },
    });
    // A newly linked workspace gets its agent wired to this CRM straight away
    // (tools + prompt), so Kewy AI can book without anyone configuring it.
    if (updated.lWorkspaceId && body.lWorkspaceId) {
      await this.agentSetup.ensureQuietly(id);
    }
    return {
      ...updated,
      createdAt: updated.createdAt.toISOString(),
      suspendedAt: updated.suspendedAt ? updated.suspendedAt.toISOString() : null,
      enabledModules: Array.isArray(updated.enabledModules)
        ? (updated.enabledModules as string[])
        : null,
    };
  }
}
