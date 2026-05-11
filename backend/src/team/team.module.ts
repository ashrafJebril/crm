import { Controller, Get, Module } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Controller("team")
class TeamController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list() {
    const users = await this.prisma.user.findMany({
      select: {
        id: true,
        name: true,
        role: true,
        initials: true,
        color: true,
        status: true,
        twoFA: true,
        email: true,
      },
      orderBy: { createdAt: "asc" },
    });
    return users;
  }
}

@Module({ controllers: [TeamController] })
export class TeamModule {}
