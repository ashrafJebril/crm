import { Controller, Get, Module } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Controller("dashboard")
class DashboardController {
  constructor(private readonly prisma: PrismaService) {}

  @Get("summary")
  async summary() {
    const [contacts, conversations, appointments, campaigns, templates] =
      await Promise.all([
        this.prisma.contact.count(),
        this.prisma.conversation.count(),
        this.prisma.appointment.count(),
        this.prisma.campaign.count(),
        this.prisma.template.count(),
      ]);

    const [aiHandled, escalated, unread] = await Promise.all([
      this.prisma.conversation.count({ where: { status: "ai" } }),
      this.prisma.conversation.count({ where: { escalated: true } }),
      this.prisma.conversation.aggregate({ _sum: { unread: true } }),
    ]);

    const runningCampaigns = await this.prisma.campaign.findMany({
      where: { status: "running" },
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
