/**
 * SP-26 Task 2 world (not a runtime file): the members world plus the REAL
 * AuthService, AuthGuard, SessionVersionService, PasswordResetService and
 * TwoFactorService over the in-memory prisma double. JWTs are real.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcryptjs";
import { makeWorld, NOW, U } from "../../members/__fixtures__/members-world";
import { WorkspacesService } from "../../workspaces/workspaces.service";
import { AuthService } from "../auth.service";
import { AuthGuard } from "../auth.guard";
import { SessionVersionService } from "../session-version.service";
import { PasswordResetService } from "../password-reset.service";
import { TwoFactorService } from "../two-factor.service";

export const PW = "correct-horse-1";
export const SECRET = "auth-world-jwt-secret-at-least-32-chars";
export const ENC_KEY = "auth-world-token-enc-key-48-characters-long-x";

export function makeAuthWorld() {
  const w = makeWorld();
  const hash = bcrypt.hashSync(PW, 4);
  for (const u of w.db.user) u.password = hash;
  const jwt = new JwtService({ secret: SECRET, signOptions: { expiresIn: "7d" } });
  const sessions = new SessionVersionService(w.prisma);
  const kewySync = { passwordReset: jest.fn().mockResolvedValue(undefined), passwordChanged: jest.fn().mockResolvedValue(undefined), backfill: jest.fn(), userCreated: jest.fn() };
  const twoFactor = new TwoFactorService(w.prisma, jwt, w.audit, sessions, w.permissions, w.email);
  const resets = new PasswordResetService(w.prisma, w.audit, w.email, kewySync as never, sessions);
  const workspaces = new WorkspacesService(w.prisma, kewySync as never, w.permissions, w.audit, w.handover);
  const auth = new AuthService(w.prisma, jwt, workspaces, {} as never, kewySync as never, twoFactor, sessions);
  const guard = new AuthGuard(jwt, { getAllAndOverride: () => false } as never, { isLocked: jest.fn().mockResolvedValue(false) } as never, sessions);
  let clock = NOW;
  const setClock = (d: Date) => {
    clock = d;
  };
  twoFactor.now = () => clock;
  resets.now = () => clock;
  const advance = (ms: number) => setClock(new Date(clock.getTime() + ms));

  /** Runs AuthGuard for a Bearer token; resolves the req.user or rejects. */
  const authenticate = async (token: string) => {
    const req: any = { headers: { authorization: `Bearer ${token}` } };
    await guard.canActivate({ getHandler: () => "h", getClass: () => "c", switchToHttp: () => ({ getRequest: () => req }) } as never);
    return req.user;
  };
  const userRow = (id: string) => w.db.user.find((u) => u.id === id);
  return { ...w, jwt, sessions, kewySync, twoFactor, resets, workspaces, auth, guard, authenticate, userRow, now: () => clock, setClock, advance, U };
}
