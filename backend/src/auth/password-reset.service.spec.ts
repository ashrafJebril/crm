import { ConsoleLogger, HttpException, Logger, UnauthorizedException } from "@nestjs/common";
import { HTTP_CODE_METADATA } from "@nestjs/common/constants";
import * as bcrypt from "bcryptjs";
import { AuthController } from "./auth.controller";
import { hashToken } from "../members/token-hash";
import { RESET_LIVE_MAX } from "../members/members-constants";
import { tokenOf, WS } from "../members/__fixtures__/members-world";
import { makeAuthWorld, PW } from "./__fixtures__/auth-world";

async function failure(p: Promise<unknown>) {
  const e = await p.then(
    () => {
      throw new Error("expected a failure");
    },
    (err: unknown) => err,
  );
  if (!(e instanceof HttpException)) throw e;
  return { status: e.getStatus(), key: (e.getResponse() as { message?: unknown }).message };
}

/** forgot + wait for the background send; returns the emailed token. */
async function requestReset(w: ReturnType<typeof makeAuthWorld>, email: string, ip = "1.1.1.1") {
  expect(w.resets.forgot(email, "en", ip)).toEqual({ ok: true });
  await w.resets.pending;
  const mail = w.email.lastTo(email);
  return mail ? tokenOf(mail.text.replace("/#/reset-password?token=", "/x?token=")) : null;
}

describe("PasswordResetService (SP-26)", () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.AUTH_SOURCE = "local";
  });
  afterEach(() => {
    process.env = { ...env };
  });

  it("the emailed reset link is a hash link (the token never reaches a server)", async () => {
    const w = makeAuthWorld();
    expect(w.resets.forgot("agent@acme.test", "en", "9.9.9.9")).toEqual({ ok: true });
    await w.resets.pending;
    const text = w.email.lastTo("agent@acme.test")?.text ?? "";
    expect(text).toMatch(/\/#\/reset-password\?token=[A-Za-z0-9_-]{43}/);
    expect(text).not.toMatch(/\/reset\?token=/);
  });

  it("reset token hashed and single-use", async () => {
    const w = makeAuthWorld();
    const token = await requestReset(w, "agent@acme.test");
    expect(token).toBeTruthy();
    expect(w.db.passwordReset).toHaveLength(1);
    expect(w.db.passwordReset[0]).toMatchObject({ userId: w.U.agent, tokenHash: hashToken(token as string), usedAt: null, requestedIp: "1.1.1.1" });
    expect(JSON.stringify(w.db)).not.toContain(token as string);
    expect(w.email.lastTo("agent@acme.test")?.kind).toBe("password_reset");

    await expect(w.resets.reset(token, "brand-new-pass")).resolves.toEqual({ ok: true });
    expect(await bcrypt.compare("brand-new-pass", w.userRow(w.U.agent).password)).toBe(true);
    expect(w.db.auditLog.filter((a) => a.action === "security.password_reset").map((a) => a.workspaceId)).toEqual([WS]);

    expect(await failure(w.resets.reset(token, "another-pass-1"))).toMatchObject({ status: 410, key: "auth.reset_invalid" });

    // Expired: 30 min TTL, fake clock +31 min.
    const late = await requestReset(w, "agent@acme.test");
    w.advance(31 * 60_000);
    expect(await failure(w.resets.reset(late, "another-pass-1"))).toMatchObject({ status: 410, key: "auth.reset_invalid" });
    // Malformed or unknown tokens: the same 410; a short password: 400.
    expect(await failure(w.resets.reset("x".repeat(43), "another-pass-1"))).toMatchObject({ status: 410 });
    expect(await failure(w.resets.reset(undefined, "another-pass-1"))).toMatchObject({ status: 410 });
    expect(await failure(w.resets.reset(late, "short"))).toMatchObject({ status: 400, key: "auth.password_too_short" });

    // The 4th request leaves at most 3 live rows.
    for (let i = 0; i < 4; i++) await w.resets.sendIfEligible("viewer@acme.test", "ar", undefined);
    const live = w.db.passwordReset.filter((r) => r.userId === w.U.viewer && r.usedAt === null && r.expiresAt > w.now());
    expect(live).toHaveLength(RESET_LIVE_MAX);
    expect(w.db.passwordReset.filter((r) => r.userId === w.U.viewer)).toHaveLength(4);
  });

  it("reset bumps session version and old jwt is 401", async () => {
    const w = makeAuthWorld();
    const before = (await w.auth.login({ email: "agent@acme.test", password: PW })) as { token: string };
    await expect(w.authenticate(before.token)).resolves.toMatchObject({ sub: w.U.agent, sv: 0 });
    const token = await requestReset(w, "agent@acme.test");
    await w.resets.reset(token, "brand-new-pass");
    expect(w.userRow(w.U.agent).sessionVersion).toBe(1);
    const err = await w.authenticate(before.token).catch((e) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect(err.getResponse()).toMatchObject({ message: "auth.session_expired" });
    // No automatic login: the user signs in again (and gets sv 1).
    const after = (await w.auth.login({ email: "agent@acme.test", password: "brand-new-pass" })) as { token: string };
    await expect(w.authenticate(after.token)).resolves.toMatchObject({ sv: 1 });
  });

  it("tokens without sv still work until the first bump", async () => {
    const w = makeAuthWorld();
    const legacy = await w.jwt.signAsync({ sub: w.U.admin, email: "admin@acme.test", role: "Agent", workspaceId: WS });
    await expect(w.authenticate(legacy)).resolves.toMatchObject({ sub: w.U.admin });
    // change-password bumps and hands back a working token.
    const res = await w.auth.changePassword(w.U.admin, { currentPassword: PW, newPassword: "changed-pass-1" }, WS);
    expect(res).toMatchObject({ ok: true, token: expect.any(String) });
    await expect(w.authenticate(legacy)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(w.authenticate(res.token)).resolves.toMatchObject({ sv: 1, workspaceId: WS });
  });

  it("forgot password is 202 for unknown and known emails alike", async () => {
    const w = makeAuthWorld();
    // SSO-only (no password) and a Kewy-managed user.
    w.userRow(w.U.viewer).password = null;
    w.userRow(w.U.limited).kewyAccountId = "kw-1";
    const ctl = new AuthController({} as never, {} as never, w.resets, {} as never);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, AuthController.prototype.forgotPassword)).toBe(202);
    const req = (ip: string) => ({ headers: { "fly-client-ip": ip } }) as never;
    for (const email of ["nobody@nowhere.test", "viewer@acme.test", "agent@acme.test"]) {
      expect(ctl.forgotPassword({ email }, req("2.2.2.2"))).toEqual({ ok: true });
      await w.resets.pending;
    }
    process.env.AUTH_SOURCE = "kewy_with_fallback";
    expect(ctl.forgotPassword({ email: "limited@acme.test" }, req("2.2.2.2"))).toEqual({ ok: true });
    await w.resets.pending;
    process.env.AUTH_SOURCE = "kewy";
    expect(ctl.forgotPassword({ email: "admin@acme.test" }, req("2.2.2.2"))).toEqual({ ok: true });
    await w.resets.pending;
    // Only the local-password user got an email.
    expect(w.email.sent.map((m) => m.to)).toEqual(["agent@acme.test"]);
    expect(w.db.passwordReset.map((r) => r.userId)).toEqual([w.U.agent]);
  });

  it("forgot and reset are rate limited (per email and per IP)", async () => {
    const w = makeAuthWorld();
    for (let i = 0; i < 5; i++) w.resets.forgot("a@x.test", "en", `9.9.9.${i}`);
    expect(() => w.resets.forgot("A@x.test", "en", "9.9.9.99")).toThrow(HttpException);
    for (let i = 0; i < 20; i++) w.resets.forgot(`u${i}@x.test`, "en", "8.8.8.8");
    let err: HttpException | null = null;
    try {
      w.resets.forgot("u99@x.test", "en", "8.8.8.8");
    } catch (e) {
      err = e as HttpException;
    }
    expect(err?.getStatus()).toBe(429);
    for (let i = 0; i < 10; i++) await w.resets.reset("x".repeat(43), "long-enough-1", "7.7.7.7").catch(() => undefined);
    expect(await failure(w.resets.reset("x".repeat(43), "long-enough-1", "7.7.7.7"))).toMatchObject({ status: 429, key: "auth.rate_limited" });
    await w.resets.pending;
  });

  it("with email off nobody gets a reset link (no anonymous link)", async () => {
    const w = makeAuthWorld();
    (w.email as unknown as { enabled: boolean }).enabled = false;
    expect(w.resets.forgot("agent@acme.test", "en", "3.3.3.3")).toEqual({ ok: true });
    await w.resets.pending;
    expect(w.db.passwordReset ?? []).toHaveLength(0);
    expect(w.email.sent).toHaveLength(0);
  });

  it("two concurrent submits of one link: exactly one resets, Kewy is written once", async () => {
    const w = makeAuthWorld();
    const token = await requestReset(w, "agent@acme.test");
    const results = await Promise.allSettled([w.resets.reset(token, "first-pass-11"), w.resets.reset(token, "second-pass-22")]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(w.kewySync.passwordReset).toHaveBeenCalledTimes(1);
    const winner = results[0].status === "fulfilled" ? "first-pass-11" : "second-pass-22";
    expect(await bcrypt.compare(winner, w.userRow(w.U.agent).password)).toBe(true);
    expect(w.kewySync.passwordReset.mock.calls[0][1]).toBe(w.userRow(w.U.agent).password);
    expect(w.userRow(w.U.agent).sessionVersion).toBe(1);
  });

  describe("logging", () => {
    let lines: string[];
    beforeEach(() => {
      lines = [];
      const cap = (...a: unknown[]) => lines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
      Logger.overrideLogger({ log: cap, error: cap, warn: cap, debug: cap, verbose: cap, fatal: cap });
      for (const k of ["log", "info", "warn", "error", "debug"] as const) jest.spyOn(console, k).mockImplementation(cap);
    });
    afterEach(() => {
      Logger.overrideLogger(new ConsoleLogger());
      jest.restoreAllMocks();
    });

    it("no token, code or password in any log line", async () => {
      const w = makeAuthWorld();
      const token = await requestReset(w, "agent@acme.test");
      await w.resets.reset(token, "brand-new-pass");
      // A provider failure in the background send is logged without secrets.
      w.email.fail = new Error("provider down");
      w.resets.forgot("agent@acme.test", "en", "4.4.4.4");
      await w.resets.pending;
      expect(lines.length).toBeGreaterThan(0);
      const all = lines.join("\n");
      for (const s of [token as string, "brand-new-pass", PW, "agent@acme.test"]) expect(all).not.toContain(s);
      const audit = JSON.stringify(w.db.auditLog);
      expect(audit).not.toMatch(/brand-new|\$2[aby]\$/);
      expect(audit).not.toContain(token as string);
    });
  });
});
