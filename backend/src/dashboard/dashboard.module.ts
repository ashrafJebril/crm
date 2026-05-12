import { Controller, Get, Module } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CurrentWorkspace } from "../common/current-workspace.decorator";

@Controller("dashboard")
class DashboardController {
  constructor(private readonly prisma: PrismaService) {}

  @Get("summary")
  async summary(@CurrentWorkspace() workspaceId: string) {
    const [contacts, conversations, appointments, campaigns, templates] =
      await Promise.all([
        this.prisma.contact.count({ where: { workspaceId } }),
        this.prisma.conversation.count({ where: { workspaceId } }),
        this.prisma.appointment.count({ where: { workspaceId } }),
        this.prisma.campaign.count({ where: { workspaceId } }),
        this.prisma.template.count({ where: { workspaceId } }),
      ]);

    const [aiHandled, escalated, unread] = await Promise.all([
      this.prisma.conversation.count({ where: { workspaceId, status: "ai" } }),
      this.prisma.conversation.count({ where: { workspaceId, escalated: true } }),
      this.prisma.conversation.aggregate({
        where: { workspaceId },
        _sum: { unread: true },
      }),
    ]);

    const runningCampaigns = await this.prisma.campaign.findMany({
      where: { workspaceId, status: "running" },
      take: 3,
    });

    return {
      counts: {
        contacts,
        conversations,
        appointments,
        campaigns,
        templates,
        aiHandled,
        escalated,
        unread: unread._sum.unread ?? 0,
      },
      aiResolutionPct:
        conversations > 0 ? Math.round((aiHandled / conversations) * 100) : 0,
      runningCampaigns,
    };
  }
}

@Module({ controllers: [DashboardController] })
export class DashboardModule {}
