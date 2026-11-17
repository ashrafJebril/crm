import { ConsoleLogger, ForbiddenException, HttpException, Logger, UnauthorizedException } from "@nestjs/common";
import { TeamController } from "../team/team.module";
import { AuthController } from "./auth.controller";
import { normaliseRecoveryCode } from "./recovery-codes";
import { WorkspacesController } from "../workspaces/workspaces.controller";
import { stepAt, totpAt } from "./totp";
import { ENC_KEY, makeAuthWorld, PW } from "./__fixtures__/auth-world";
import { WS, WS2 } from "../members/__fixtures__/members-world";

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

/** Enrols `userId`: setup + enable at the current step. Returns the secret and recovery codes. */
async function enrol(w: ReturnType<typeof makeAuthWorld>, userId: string) {
  const { secret, otpauthUrl } = await w.twoFactor.setup(userId);
  const code = totpAt(secret, stepAt(w.now().getTime()));
  const { recoveryCodes } = await w.twoFactor.enable(userId, code);
  return { secret, otpauthUrl, recoveryCodes };
}

const codeAt = (w: ReturnType<typeof makeAuthWorld>, secret: string) => totpAt(secret, stepAt(w.now().getTime()));
const login = (w: ReturnType<typeof makeAuthWorld>, email: string) => w.auth.login({ email, password: PW }) as Promise<Record<string, any>>;

describe("TwoFactorService (SP-26)", () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.TOKEN_ENC_KEY = ENC_KEY;
    process.env.AUTH_SOURCE = "local";
  });
  afterEach(() => {
    process.env = { ...env };
  });

  it("2FA required at login once enabled", async () => {
    const w = makeAuthWorld();
    // Before enrolment: one step.
    expect(await login(w, "agent@acme.test")).toMatchObject({ token: expect.any(String) });

    const { secret, otpauthUrl, recoveryCodes } = await enrol(w, w.U.agent);
    expect(otpauthUrl).toContain(`secret=${secret}`);
    expect(recoveryCodes).toHaveLength(10);
    expect(w.userRow(w.U.agent)).toMatchObject({ twoFA: true, totpPendingEnc: null });

    // The password now yields a challenge and no token.
    w.advance(30_000);
    const first = await login(w, "agent@acme.test");
    expect(first).toEqual({ twoFactorRequired: true, challenge: expect.any(String) });
    expect(first).not.toHaveProperty("token");

    expect(await failure(w.twoFactor.verify({ challenge: first.challenge, code: "000000" }))).toMatchObject({
      status: 400,
      key: "auth.2fa_code_invalid",
    });
    const userId = await w.twoFactor.verify({ challenge: first.challenge, code: codeAt(w, secret) });
    const session = await w.auth.loginAfterTwoFactor(userId);
    expect(session).toMatchObject({ token: expect.any(String), activeWorkspaceId: WS, user: { id: w.U.agent, twoFA: true } });

    // A recovery code works once.
    const second = await login(w, "agent@acme.test");
    const rc = recoveryCodes[3];
    await expect(w.twoFactor.verify({ challenge: second.challenge, recoveryCode: rc })).resolves.toBe(w.U.agent);
    expect(w.userRow(w.U.agent).totpRecoveryHashes).toHaveLength(9);
    expect(await failure(w.twoFactor.verify({ challenge: second.challenge, recoveryCode: rc }))).toMatchObject({
      status: 400,
      key: "auth.2fa_code_invalid",
    });
    // Exactly one of code or recovery code.
    expect(await failure(w.twoFactor.verify({ challenge: second.challenge }))).toMatchObject({ status: 400 });
    expect(
      await failure(w.twoFactor.verify({ challenge: second.challenge, code: codeAt(w, secret), recoveryCode: recoveryCodes[0] })),
    ).toMatchObject({ status: 400 });

    // A user without 2FA logs in in one step.
    expect(await login(w, "admin@acme.test")).toMatchObject({ token: expect.any(String), activeWorkspaceId: WS });
  });

  it("totp code replay in the same step is refused", async () => {
    const w = makeAuthWorld();
    const { secret } = await enrol(w, w.U.agent);
    // The enable code's own step cannot be reused.
    const c1 = await login(w, "agent@acme.test");
    expect(await failure(w.twoFactor.verify({ challenge: c1.challenge, code: codeAt(w, secret) }))).toMatchObject({ status: 400 });
    w.advance(30_000);
    const code = codeAt(w, secret);
    await expect(w.twoFactor.verify({ challenge: c1.challenge, code })).resolves.toBe(w.U.agent);
    const c2 = await login(w, "agent@acme.test");
    expect(await failure(w.twoFactor.verify({ challenge: c2.challenge, code }))).toMatchObject({ status: 400, key: "auth.2fa_code_invalid" });
    // Concurrent attempts with one fresh code: exactly one wins.
    w.advance(30_000);
    const fresh = codeAt(w, secret);
    const results = await Promise.allSettled([
      w.twoFactor.verify({ challenge: c2.challenge, code: fresh }),
      w.twoFactor.verify({ challenge: c2.challenge, code: fresh }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
  });

  it("2fa verify is rate limited", async () => {
    const w = makeAuthWorld();
    await enrol(w, w.U.agent);
    const { challenge } = await login(w, "agent@acme.test");
    for (let i = 0; i < 10; i++) {
      expect(await failure(w.twoFactor.verify({ challenge, code: "000000" }), )).toMatchObject({ status: 400 });
    }
    expect(await failure(w.twoFactor.verify({ challenge, code: "000000" }))).toMatchObject({ status: 429, key: "auth.rate_limited" });
    // A garbage challenge never reaches the per-user bucket.
    expect(await failure(w.twoFactor.verify({ challenge: "nope", code: "000000" }))).toMatchObject({ status: 401, key: "auth.2fa_challenge_invalid" });
  });

  it("2fa challenge token is refused by AuthGuard", async () => {
    const w = makeAuthWorld();
    await enrol(w, w.U.agent);
    const { challenge } = await login(w, "agent@acme.test");
    expect(w.jwt.decode(challenge)).toMatchObject({ sub: w.U.agent, purpose: "2fa" });
    await expect(w.authenticate(challenge)).rejects.toBeInstanceOf(UnauthorizedException);
    // A session token is not a challenge either.
    const plain = (await login(w, "admin@acme.test")).token;
    await expect(w.authenticate(plain)).resolves.toMatchObject({ sub: w.U.admin, sv: 0 });
    expect(await failure(w.twoFactor.verify({ challenge: plain, code: "123456" }))).toMatchObject({ status: 401 });
  });

  it("totp secret stored encrypted and never returned", async () => {
    const w = makeAuthWorld();
    const { secret } = await w.twoFactor.setup(w.U.agent);
    expect(w.userRow(w.U.agent).totpPendingEnc).toMatch(/^enc:v1:/);
    expect(w.userRow(w.U.agent).totpPendingEnc).not.toContain(secret);
    await w.twoFactor.enable(w.U.agent, codeAt(w, secret));
    const row = w.userRow(w.U.agent);
    expect(row.totpSecretEnc).toMatch(/^enc:v1:/);
    for (const h of row.totpRecoveryHashes) expect(h).toMatch(/^\$2[aby]\$/);
    const me = await w.auth.me(w.U.agent);
    expect(me).toMatchObject({ twoFA: true });
    const team = await new TeamController(w.prisma, w.permissions).list(WS);
    const leaks = /totp|enc:v1|secret|recovery|\$2[aby]\$/i;
    expect(JSON.stringify(me)).not.toMatch(leaks);
    expect(JSON.stringify(team)).not.toMatch(leaks);
    expect(JSON.stringify(me)).not.toContain(secret);
    expect(team.find((m) => m.id === w.U.agent)).toMatchObject({ twoFA: true });
  });

  it("setup refuses without TOKEN_ENC_KEY in production", async () => {
    const w = makeAuthWorld();
    delete process.env.TOKEN_ENC_KEY;
    process.env.NODE_ENV = "production";
    expect(await failure(w.twoFactor.setup(w.U.agent))).toMatchObject({ status: 503, key: "auth.encryption_unavailable" });
    expect(w.userRow(w.U.agent).totpPendingEnc ?? null).toBeNull();
    // Enabling twice or without setup is refused.
    process.env.NODE_ENV = "test";
    expect(await failure(w.twoFactor.enable(w.U.agent, "123456"))).toMatchObject({ status: 409, key: "auth.2fa_not_enabled" });
  });

  it("disable needs password and code and bumps session version", async () => {
    const w = makeAuthWorld();
    const { secret } = await enrol(w, w.U.agent);
    w.advance(30_000);
    const before = (await w.auth.loginAfterTwoFactor(w.U.agent)).token;
    await expect(w.authenticate(before)).resolves.toBeDefined();
    expect((await failure(w.twoFactor.disable(w.U.agent, "wrong-password", { code: codeAt(w, secret) }))).status).toBe(400);
    expect(await failure(w.twoFactor.disable(w.U.agent, PW, { code: "000000" }))).toMatchObject({ status: 400, key: "auth.2fa_code_invalid" });
    expect(w.userRow(w.U.agent).twoFA).toBe(true);
    await expect(w.twoFactor.disable(w.U.agent, PW, { code: codeAt(w, secret) })).resolves.toEqual({ ok: true });
    expect(w.userRow(w.U.agent)).toMatchObject({
      twoFA: false, totpSecretEnc: null, totpPendingEnc: null, totpEnabledAt: null, totpLastStep: null, totpRecoveryHashes: [], sessionVersion: 2, // enable 1, disable 2
    });
    await expect(w.authenticate(before)).rejects.toMatchObject({ response: { message: "auth.session_expired" } });
    // The controller hands back a fresh token that works.
    const fresh = await w.auth.reissue(w.U.agent, WS);
    await expect(w.authenticate(fresh.token)).resolves.toMatchObject({ sv: 2, workspaceId: WS });
    expect(w.db.auditLog.filter((a) => a.action === "security.2fa_disabled").map((a) => a.workspaceId)).toEqual([WS]);
    expect(w.db.auditLog.filter((a) => a.action === "security.2fa_enabled")).toHaveLength(1);
  });

  it("owner 2fa reset refused for user in another workspace", async () => {
    const w = makeAuthWorld();
    await enrol(w, w.U.agent);
    w.db.workspaceMember.push({ id: "m_agent2", userId: w.U.agent, workspaceId: WS2, role: "agent", roleId: null, createdAt: new Date(), updatedAt: new Date() });
    const err = await w.twoFactor.resetByOwner(WS, w.U.agent, { userId: w.U.owner }).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(w.userRow(w.U.agent).twoFA).toBe(true);
    // Impersonators never; a foreign member id is 404.
    expect((await w.twoFactor.resetByOwner(WS, w.U.agent, { userId: "support", impersonating: true }).catch((e) => e))).toBeInstanceOf(ForbiddenException);
    expect(await failure(w.twoFactor.resetByOwner(WS, w.U.other, { userId: w.U.owner }))).toMatchObject({ status: 404 });

    // Single-workspace member: reset works, is audited, emailed, and ends sessions.
    w.db.workspaceMember = w.db.workspaceMember.filter((m) => m.id !== "m_agent2");
    const token = (await w.auth.loginAfterTwoFactor(w.U.agent)).token;
    await expect(w.twoFactor.resetByOwner(WS, w.U.agent, { userId: w.U.owner })).resolves.toEqual({ ok: true });
    expect(w.userRow(w.U.agent)).toMatchObject({ twoFA: false, totpSecretEnc: null, sessionVersion: 2 });
    expect(w.db.auditLog.filter((a) => a.action === "security.2fa_reset_by_owner")).toEqual([
      expect.objectContaining({ workspaceId: WS, actorId: w.U.owner, targetId: w.U.agent }),
    ]);
    const mail = w.email.lastTo("agent@acme.test");
    expect(mail?.kind).toBe("two_factor_reset");
    await expect(w.authenticate(token)).rejects.toBeInstanceOf(UnauthorizedException);
    // The route sits on the workspaces controller.
    const ctl = new WorkspacesController({ requireMember: jest.fn() } as never, undefined, w.twoFactor);
    expect(await failure(ctl.resetTwoFactor(WS, w.U.agent, { user: { sub: w.U.owner, workspaceId: WS } } as never))).toMatchObject({
      status: 409,
      key: "auth.2fa_not_enabled",
    });
  });

  it("enabling ends other sessions and the controller returns a fresh token with the codes", async () => {
    const w = makeAuthWorld();
    const before = (await login(w, "agent@acme.test")).token as string;
    await expect(w.authenticate(before)).resolves.toMatchObject({ sv: 0 });
    const { secret } = await w.twoFactor.setup(w.U.agent);
    const ctl = new AuthController(w.auth, {} as never, w.resets, w.twoFactor);
    const req = { user: { sub: w.U.agent, workspaceId: WS } } as never;
    const res = await ctl.enableTwoFactor({ code: codeAt(w, secret) }, req);
    expect(res.recoveryCodes).toHaveLength(10);
    expect(w.userRow(w.U.agent).sessionVersion).toBe(1);
    await expect(w.authenticate(before)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(w.authenticate(res.token)).resolves.toMatchObject({ sv: 1, workspaceId: WS });
  });

  it("disable accepts a recovery code with the password", async () => {
    const w = makeAuthWorld();
    const { recoveryCodes } = await enrol(w, w.U.agent);
    expect(await failure(w.twoFactor.disable(w.U.agent, PW, { recoveryCode: "aaaa-aaaa" }))).toMatchObject({ status: 400 });
    expect(await failure(w.twoFactor.disable(w.U.agent, PW, {}))).toMatchObject({ status: 400, key: "auth.2fa_code_invalid" });
    expect((await failure(w.twoFactor.disable(w.U.agent, "nope", { recoveryCode: recoveryCodes[0] }))).status).toBe(400);
    await expect(w.twoFactor.disable(w.U.agent, PW, { recoveryCode: recoveryCodes[0] })).resolves.toEqual({ ok: true });
    expect(w.userRow(w.U.agent)).toMatchObject({ twoFA: false, totpRecoveryHashes: [], sessionVersion: 2 });
  });

  it("regenerating recovery codes needs the password and a factor, replaces every code and is audited", async () => {
    const w = makeAuthWorld();
    const { secret, recoveryCodes } = await enrol(w, w.U.agent);
    const oldHashes = [...w.userRow(w.U.agent).totpRecoveryHashes];
    expect((await failure(w.twoFactor.regenerateRecoveryCodes(w.U.agent, "nope", { recoveryCode: recoveryCodes[0] }))).status).toBe(400);
    w.advance(30_000);
    const ctl = new AuthController(w.auth, {} as never, w.resets, w.twoFactor);
    const res = await ctl.regenerateRecoveryCodes({ password: PW, code: codeAt(w, secret) }, { user: { sub: w.U.agent, workspaceId: WS } } as never);
    expect(res.recoveryCodes).toHaveLength(10);
    const row = w.userRow(w.U.agent);
    expect(row.totpRecoveryHashes).toHaveLength(10);
    for (const h of row.totpRecoveryHashes) expect(oldHashes).not.toContain(h);
    expect(JSON.stringify(row)).not.toContain(normaliseRecoveryCode(res.recoveryCodes[0]));
    // Old codes are dead, new ones work; the session version is unchanged.
    expect(row.sessionVersion).toBe(1);
    const { challenge } = await login(w, "agent@acme.test");
    expect(await failure(w.twoFactor.verify({ challenge, recoveryCode: recoveryCodes[1] }))).toMatchObject({ status: 400 });
    await expect(w.twoFactor.verify({ challenge, recoveryCode: res.recoveryCodes[1] })).resolves.toBe(w.U.agent);
    expect(w.db.auditLog.filter((a) => a.action === "security.2fa_recovery_codes_regenerated")).toHaveLength(1);
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
      const { secret, recoveryCodes } = await enrol(w, w.U.agent);
      const secrets = [secret, PW, ...recoveryCodes];
      const { challenge } = await login(w, "agent@acme.test");
      secrets.push(challenge);
      w.advance(30_000);
      const code = codeAt(w, secret);
      secrets.push(code);
      await w.twoFactor.verify({ challenge, code: "000000" }).catch(() => undefined);
      await w.twoFactor.verify({ challenge, code });
      await w.twoFactor.verify({ challenge, recoveryCode: recoveryCodes[0] });
      // An email failure on the owner reset is logged without the address.
      w.email.fail = new Error(`provider echoed ${secret}`);
      await w.twoFactor.resetByOwner(WS, w.U.agent, { userId: w.U.owner });
      expect(lines.length).toBeGreaterThan(0);
      const all = lines.join("\n");
      for (const s of secrets) expect(all).not.toContain(s);
      expect(all).not.toContain("agent@acme.test");
      expect(JSON.stringify(w.db.auditLog)).not.toMatch(/secret|code"|password|enc:v1/i);
    });
  });
});
