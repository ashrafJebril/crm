import { Controller, Get, Module } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CurrentWorkspace } from "../common/current-workspace.decorator";

@Controller("team")
class TeamController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@CurrentWorkspace() workspaceId: string) {
    const members = await this.prisma.workspaceMember.findMany({
      where: { workspaceId },
      include: { user: true },
      orderBy: { createdAt: "asc" },
    });
    return members.map((m) => ({
      id: m.user.id,
      email: m.user.email,
      name: m.user.name,
      role: m.role, // workspace-scoped role
      initials: m.user.initials,
      color: m.user.color,
      status: m.user.status,
    }));
  }
}

@Module({ controllers: [TeamController] })
export class TeamModule {}
