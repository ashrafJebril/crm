import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import {
  AddMemberDto,
  CreateWorkspaceDto,
  UpdateMemberRoleDto,
  UpdateWorkspaceDto,
  WorkspaceRole,
} from "./workspaces.dto";

function toSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "workspace"
  );
}

@Injectable()
export class WorkspacesService {
  constructor(private readonly prisma: PrismaService) {}

  async listForUser(userId: string) {
    const memberships = await this.prisma.workspaceMember.findMany({
      where: { userId },
      include: { workspace: true },
      orderBy: { createdAt: "asc" },
    });
    return memberships.map((m) => ({
      id: m.workspace.id,
      name: m.workspace.name,
      slug: m.workspace.slug,
      timezone: m.workspace.timezone,
      lang: m.workspace.lang,
      plan: m.workspace.plan,
      role: m.role as WorkspaceRole,
    }));
  }

  async get(id: string) {
    const ws = await this.prisma.workspace.findUnique({ where: { id } });
    if (!ws) throw new NotFoundException("Workspace not found");
    return ws;
  }

  async create(dto: CreateWorkspaceDto, ownerUserId: string) {
    const baseSlug = toSlug(dto.name);
    let slug = baseSlug;
    let suffix = 0;
    while (await this.prisma.workspace.findUnique({ where: { slug } })) {
      suffix += 1;
      slug = `${baseSlug}-${suffix}`;
    }
    const ws = await this.prisma.workspace.create({
      data: {
        name: dto.name,
        slug,
        timezone: dto.timezone ?? "Asia/Riyadh",
        lang: dto.lang ?? "ar",
      },
    });
    await this.prisma.workspaceMember.create({
      data: { userId: ownerUserId, workspaceId: ws.id, role: "owner" },
    });
    return ws;
  }

  async update(id: string, dto: UpdateWorkspaceDto) {
    await this.get(id);
    return this.prisma.workspace.update({ where: { id }, data: dto });
  }

  async requireMember(userId: string, workspaceId: string): Promise<WorkspaceRole> {
    const m = await this.prisma.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId, workspaceId } },
    });
    if (!m) throw new ForbiddenException("Not a member of this workspace");
    return m.role as WorkspaceRole;
  }

  async listMembers(workspaceId: string) {
    return this.prisma.workspaceMember.findMany({
      where: { workspaceId },
      include: { user: true },
      orderBy: { createdAt: "asc" },
    });
  }

  async addMember(workspaceId: string, dto: AddMemberDto) {
    const exists = await this.prisma.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId: dto.userId, workspaceId } },
    });
    if (exists) throw new ConflictException("Already a member");
    return this.prisma.workspaceMember.create({
      data: { userId: dto.userId, workspaceId, role: dto.role },
    });
  }

  async updateMemberRole(
    workspaceId: string,
    userId: string,
    dto: UpdateMemberRoleDto,
  ) {
    const m = await this.prisma.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId, workspaceId } },
    });
    if (!m) throw new NotFoundException("Member not found");
    return this.prisma.workspaceMember.update({
      where: { id: m.id },
      data: { role: dto.role },
    });
  }

  async removeMember(workspaceId: string, userId: string) {
    const m = await this.prisma.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId, workspaceId } },
    });
    if (!m) throw new NotFoundException("Member not found");
    await this.prisma.workspaceMember.delete({ where: { id: m.id } });
    return { ok: true };
  }
}
