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
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw new UnauthorizedException("Invalid credentials");
    // SSO-provisioned users have no local password — they must come in via
    // POST /auth/sso/exchange, not the password endpoint.
    if (!user.password) throw new UnauthorizedException("Invalid credentials");
    const ok = await bcrypt.compare(dto.password, user.password);
    if (!ok) throw new UnauthorizedException("Invalid credentials");

    const memberships = await this.workspaces.listForUser(user.id);
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
    user: { id: string; email: string; role: string },
    workspaceId: string | null,
    workspaces: Awaited<ReturnType<WorkspacesService["listForUser"]>>,
  ) {
    // Read the latest user row so isSuperAdmin reflects DB state (admins
    // promoted/demoted between login sessions get the right capability).
    const full = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      ...(workspaceId ? { workspaceId } : {}),
      ...(full.isSuperAdmin ? { isSuperAdmin: true } : {}),
    };
    const token = await this.jwt.signAsync(payload);
    return {
      token,
      user: this.shape(full),
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
