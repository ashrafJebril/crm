import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { AuthGuard, JwtPayload } from "./auth.guard";

const ctx = (req: Record<string, unknown>) =>
  ({
    getHandler: () => "h",
    getClass: () => "c",
    switchToHttp: () => ({ getRequest: () => req }),
  }) as never;

describe("AuthGuard payment lock", () => {
  let payload: JwtPayload;
  let isPublic: boolean;
  let isLocked: jest.Mock;
  let guard: AuthGuard;
  const req = () => ({ headers: { authorization: "Bearer t" } });

  beforeEach(() => {
    payload = { sub: "u1", email: "a@b.c", role: "Owner", workspaceId: "w1" };
    isPublic = false;
    isLocked = jest.fn().mockResolvedValue(true);
    guard = new AuthGuard(
      { verifyAsync: jest.fn().mockImplementation(async () => payload) } as never,
      { getAllAndOverride: () => isPublic } as never,
      { isLocked } as never,
    );
  });

  it("refuses a locked workspace with 403 PAYMENT_OVERDUE", async () => {
    const err = await guard.canActivate(ctx(req())).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getStatus()).toBe(403);
    expect(err.getResponse()).toMatchObject({ code: "PAYMENT_OVERDUE" });
    expect(isLocked).toHaveBeenCalledWith("w1");
  });

  it("passes an unlocked workspace", async () => {
    isLocked.mockResolvedValue(false);
    await expect(guard.canActivate(ctx(req()))).resolves.toBe(true);
  });

  it("passes an impersonating session without checking", async () => {
    payload.impersonating = true;
    await expect(guard.canActivate(ctx(req()))).resolves.toBe(true);
    expect(isLocked).not.toHaveBeenCalled();
  });

  it("passes a super-admin without checking", async () => {
    payload.isSuperAdmin = true;
    await expect(guard.canActivate(ctx(req()))).resolves.toBe(true);
    expect(isLocked).not.toHaveBeenCalled();
  });

  it("passes a token with no workspace", async () => {
    delete payload.workspaceId;
    await expect(guard.canActivate(ctx(req()))).resolves.toBe(true);
    expect(isLocked).not.toHaveBeenCalled();
  });

  it("never checks public routes", async () => {
    isPublic = true;
    await expect(guard.canActivate(ctx({ headers: {} }))).resolves.toBe(true);
    expect(isLocked).not.toHaveBeenCalled();
  });

  it("fails closed (not unlocked) when the lookup throws", async () => {
    isLocked.mockRejectedValue(new Error("db down"));
    const err = await guard.canActivate(ctx(req())).catch((e) => e);
    expect(err).toEqual(new Error("db down"));
    expect(err).not.toBeInstanceOf(UnauthorizedException);
  });
});
