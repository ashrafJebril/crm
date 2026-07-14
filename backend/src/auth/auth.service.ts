import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcryptjs";
import { PrismaService } from "../prisma/prisma.service";
import { WorkspacesService } from "../workspaces/workspaces.service";
import { WorkspaceRole } from "../workspaces/workspaces.dto";
import {
  ChangePasswordDto,
  LoginDto,
  RegisterDto,
  SwitchWorkspaceDto,
  UpdateProfileDto,
} from "./dto";
import type { JwtPayload } from "./auth.guard";

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly workspaces: WorkspacesService,
  ) {}

  async login(dto: LoginDto) {
    const email = dto.email.toLowerCase().trim();
    // Fetch the user AND their (non-suspended) memberships in a single query.
    // Login previously made three sequential round-trips to the remote Postgres
    // (user → memberships → re-fetch user); this collapses the first two into
    // one join, and issue() no longer re-fetches — so it's one DB round-trip
    // plus the bcrypt compare.
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: {
        memberships: {
          where: { workspace: { suspendedAt: null } },
          include: { workspace: true },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    // SSO-provisioned users have no local password — they come in via
    // POST /auth/sso/exchange, not this endpoint.
    if (!user || !user.password) throw new UnauthorizedException("Invalid credentials");
    const ok = await bcrypt.compare(dto.password, user.password);
    if (!ok) throw new UnauthorizedException("Invalid credentials");

    const memberships = user.memberships.map((m) => ({
      id: m.workspace.id,
      name: m.workspace.name,
      slug: m.workspace.slug,
      timezone: m.workspace.timezone,
      lang: m.workspace.lang,
      plan: m.workspace.plan,
      role: m.role as WorkspaceRole,
    }));

    if (memberships.length === 0) {
      // Edge case: user with no workspace memberships. Create one on the fly
      // so they always land somewhere.
      const ws = await this.workspaces.create(
        { name: `${user.name}'s workspace` },
        user.id,
      );
      return this.issue(user, ws.id, [
        {
          id: ws.id,
          name: ws.name,
          slug: ws.slug,
          timezone: ws.timezone,
          lang: ws.lang,
          plan: ws.plan,
          role: "owner",
        },
      ]);
    }
    // Default into the first workspace so the JWT always carries a workspaceId
    // (downstream routes use @CurrentWorkspace which 401s if absent). Users
    // with multiple workspaces can switch from the topbar — that re-mints the
    // JWT via /auth/switch-workspace.
    return this.issue(user, memberships[0].id, memberships);
  }

  async register(dto: RegisterDto) {
    const exists = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (exists) throw new ConflictException("Email already in use");
    const initials = dto.name
      .split(" ")
      .map((s) => s[0] ?? "")
      .join("")
      .slice(0, 2)
      .toUpperCase();
    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        password: await bcrypt.hash(dto.password, 10),
        name: dto.name,
        role: dto.role ?? "Agent",
        color: dto.color ?? "200",
        initials,
      },
    });
    const ws = await this.workspaces.create(
      { name: dto.workspaceName ?? `${dto.name}'s workspace` },
      user.id,
    );
    const memberships = await this.workspaces.listForUser(user.id);
    return this.issue(user, ws.id, memberships);
  }

  async switchWorkspace(userId: string, dto: SwitchWorkspaceDto) {
    await this.workspaces.requireMember(userId, dto.workspaceId);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const memberships = await this.workspaces.listForUser(userId);
    return this.issue(user, dto.workspaceId, memberships);
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException("User no longer exists");
    return this.shape(user);
  }

  async myWorkspaces(userId: string) {
    return this.workspaces.listForUser(userId);
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException("User no longer exists");
    const data: { name?: string; color?: string; initials?: string } = {};
    if (dto.name !== undefined) {
      data.name = dto.name;
      data.initials = dto.name
        .split(" ")
        .map((s) => s[0] ?? "")
        .join("")
        .slice(0, 2)
        .toUpperCase();
    }
    if (dto.color !== undefined) data.color = dto.color;
    const updated = await this.prisma.user.update({ where: { id: userId }, data });
    return this.shape(updated);
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException("User no longer exists");
    // SSO-provisioned users have no local password — they can't change one via
    // this endpoint. They authenticate via /auth/sso/exchange on every visit.
    if (!user.password) {
      throw new BadRequestException("This account uses SSO and has no password");
    }
    const ok = await bcrypt.compare(dto.currentPassword, user.password);
    if (!ok) throw new BadRequestException("Current password is incorrect");
    await this.prisma.user.update({
      where: { id: userId },
      data: { password: await bcrypt.hash(dto.newPassword, 10) },
    });
    return { ok: true };
  }

  private async issue(
    // Full user row — every caller (login/register/switch) already loaded it,
    // so we sign directly from it instead of re-querying the DB (one fewer
    // round-trip to the remote Postgres on every auth call). isSuperAdmin is a
    // scalar on the row, so it reflects current DB state as of that read.
    user: {
      id: string;
      email: string;
      name: string;
      role: string;
      initials: string;
      color: string;
      isSuperAdmin: boolean;
    },
    workspaceId: string | null,
    workspaces: Awaited<ReturnType<WorkspacesService["listForUser"]>>,
  ) {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      ...(workspaceId ? { workspaceId } : {}),
      ...(user.isSuperAdmin ? { isSuperAdmin: true } : {}),
    };
    const token = await this.jwt.signAsync(payload);
    return {
      token,
      user: this.shape(user),
      workspaces,
      activeWorkspaceId: workspaceId,
    };
  }

  private shape(u: {
    id: string;
    email: string;
    name: string;
    role: string;
    initials: string;
    color: string;
    isSuperAdmin: boolean;
  }) {
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      initials: u.initials,
      color: u.color,
      isSuperAdmin: u.isSuperAdmin,
    };
  }
}
