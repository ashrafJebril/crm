import { ConsoleLogger, HttpException, Logger } from "@nestjs/common";
import { FakeEmailSender } from "../email/fake-email-sender";
import { InvitationsService } from "./invitations.service";
import { INVITE_MAX_LIFETIME_MS, INVITE_RESEND_GAP_MS, INVITE_RESEND_MAX, INVITE_TTL_MS } from "./members-constants";
import { hashToken } from "./token-hash";
import { makeWorld, NOW, R, tokenOf, U, withRollback, WS, WS2 } from "./__fixtures__/members-world";

const owner = { userId: U.owner };
const admin = { userId: U.admin };

/** The error's HTTP status and message key. */
async function failure(p: Promise<unknown>): Promise<{ status: number; key: unknown; body: Record<string, unknown> }> {
  const e = await p.then(
    () => {
      throw new Error("expected a failure");
    },
    (err: unknown) => err,
  );
  if (!(e instanceof HttpException)) throw e;
  const body = e.getResponse() as Record<string, unknown>;
  return { status: e.getStatus(), key: body.message, body };
}

describe("InvitationsService (SP-26)", () => {
  it("invite token single-use and expires", async () => {
    const w = makeWorld();

    // create → the email carries a link whose token hashes to tokenHash; the raw token is never stored.
    const created = await w.invitations.create(WS, { email: " New@Example.TEST ", roleId: R.agent, lang: "en" }, owner);
    expect(created.link).toBeUndefined();
    expect(created.emailSent).toBe(true);
    expect(created.invitation).toMatchObject({ email: "new@example.test", status: "pending", role: { id: R.agent } });
    expect(created.invitation).not.toHaveProperty("tokenHash");
    const mail = w.email.lastTo("new@example.test");
    const token = tokenOf(mail?.text);
    const row = w.db.invitation.find((i) => i.id === created.invitation.id);
    expect(row.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(w.db)).not.toContain(token);
    expect(row.expiresAt.getTime()).toBe(NOW.getTime() + INVITE_TTL_MS);

    // accept → member created with the invited roleId.
    const res = await w.invitations.acceptWithToken({ token, name: "Nia New", password: "s3cret-pass" });
    expect(res).toMatchObject({ workspaceId: WS, rolePending: false });
    const m = w.db.workspaceMember.find((x) => x.userId === res.userId && x.workspaceId === WS);
    expect(m).toMatchObject({ role: "agent", roleId: R.agent });
    expect(w.db.user.find((u) => u.id === res.userId)).toMatchObject({ email: "new@example.test", name: "Nia New" });
    expect(w.db.user.find((u) => u.id === res.userId).password).not.toBe("s3cret-pass");
    expect(w.kewySync.userCreated).toHaveBeenCalledTimes(1);

    // the same token again → 410.
    expect(await failure(w.invitations.acceptWithToken({ token, name: "x", password: "s3cret-pass" }))).toMatchObject({
      status: 410,
      key: "invitations.invalid",
    });
    expect(await failure(w.invitations.preview(token))).toMatchObject({ status: 410, key: "invitations.invalid" });

    // a fresh invite at expiresAt + 1 ms → 410.
    const late = await w.invitations.create(WS, { email: "late@example.test", roleId: R.viewer }, owner);
    const lateToken = tokenOf(w.email.lastTo("late@example.test")?.text);
    w.setClock(new Date(late.invitation.expiresAt.getTime() + 1));
    expect(await failure(w.invitations.preview(lateToken))).toMatchObject({ status: 410, key: "invitations.invalid" });
    expect(await failure(w.invitations.acceptWithToken({ token: lateToken, password: "s3cret-pass" }))).toMatchObject({
      status: 410,
      key: "invitations.invalid",
    });
    w.setClock(NOW);

    // a revoked invite → 410 (and revoke is idempotent).
    const rev = await w.invitations.create(WS, { email: "rev@example.test", roleId: R.viewer }, owner);
    const revToken = tokenOf(w.email.lastTo("rev@example.test")?.text);
    await expect(w.invitations.revoke(WS, rev.invitation.id, owner)).resolves.toEqual({ ok: true });
    await expect(w.invitations.revoke(WS, rev.invitation.id, owner)).resolves.toEqual({ ok: true });
    expect(await failure(w.invitations.acceptWithToken({ token: revToken, password: "s3cret-pass" }))).toMatchObject({
      status: 410,
      key: "invitations.invalid",
    });
    expect(w.db.auditLog.filter((a) => a.action === "invitation.revoked")).toHaveLength(1);

    // resend rotates: the old token is 410, the new one works.
    const rot = await w.invitations.create(WS, { email: "rot@example.test", roleId: R.viewer }, owner);
    const oldToken = tokenOf(w.email.lastTo("rot@example.test")?.text);
    w.advance(INVITE_RESEND_GAP_MS + 1);
    const again = await w.invitations.resend(WS, rot.invitation.id, owner);
    expect(again.invitation.sendCount).toBe(2);
    const newToken = tokenOf(w.email.lastTo("rot@example.test")?.text);
    expect(newToken).not.toBe(oldToken);
    expect(await failure(w.invitations.acceptWithToken({ token: oldToken, password: "s3cret-pass" }))).toMatchObject({ status: 410 });
    await expect(w.invitations.acceptWithToken({ token: newToken, password: "s3cret-pass" })).resolves.toMatchObject({ workspaceId: WS });
  });

  it("concurrent accept: exactly one succeeds", async () => {
    const w = makeWorld();
    await w.invitations.create(WS, { email: "race@example.test", roleId: R.agent }, owner);
    const token = tokenOf(w.email.lastTo("race@example.test")?.text);
    const results = await Promise.allSettled([
      w.invitations.acceptWithToken({ token, name: "A", password: "s3cret-pass" }),
      w.invitations.acceptWithToken({ token, name: "B", password: "s3cret-pass" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((lost.reason as HttpException).getStatus()).toBe(410);
    expect(w.db.user.filter((u) => u.email === "race@example.test")).toHaveLength(1);
    expect(w.db.workspaceMember.filter((m) => m.workspaceId === WS && w.db.user.find((u) => u.id === m.userId)?.email === "race@example.test")).toHaveLength(1);
  });

  it("concurrent signed-in accept: exactly one succeeds", async () => {
    const w = makeWorld();
    await w.invitations.create(WS2, { email: "agent@acme.test", roleId: "ws2_r_agent" }, { userId: U.other });
    const token = tokenOf(w.email.lastTo("agent@acme.test")?.text);
    const results = await Promise.allSettled([w.invitations.acceptSignedIn(U.agent, token), w.invitations.acceptSignedIn(U.agent, token)]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(w.db.workspaceMember.filter((m) => m.userId === U.agent && m.workspaceId === "ws2")).toHaveLength(1);
  });

  it("admin cannot invite an owner", async () => {
    const w = makeWorld();
    expect(await failure(w.invitations.create(WS, { email: "boss@example.test", roleId: R.owner }, admin))).toMatchObject({
      status: 403,
      key: "invitations.role_above_actor",
    });
    expect(w.db.invitation).toHaveLength(0);
    // An owner can.
    await expect(w.invitations.create(WS, { email: "boss@example.test", roleId: R.owner }, owner)).resolves.toBeDefined();
  });

  it("invite above own role is 403", async () => {
    const w = makeWorld();
    // billing.manage is beyond an admin.
    expect(await failure(w.invitations.create(WS, { email: "b@example.test", roleId: R.billing }, admin))).toMatchObject({
      status: 403,
      key: "invitations.role_above_actor",
    });
    // A resend re-checks the grant too.
    const inv = await w.invitations.create(WS, { email: "b@example.test", roleId: R.billing }, owner);
    w.advance(INVITE_RESEND_GAP_MS + 1);
    expect(await failure(w.invitations.resend(WS, inv.invitation.id, admin))).toMatchObject({ status: 403 });
  });

  it("existing member is 409", async () => {
    const w = makeWorld();
    expect(await failure(w.invitations.create(WS, { email: "AGENT@acme.test", roleId: R.viewer }, owner))).toMatchObject({
      status: 409,
      key: "invitations.already_member",
    });
  });

  it("second pending invite for the same email is 409", async () => {
    const w = makeWorld();
    await w.invitations.create(WS, { email: "dup@example.test", roleId: R.viewer }, owner);
    expect(await failure(w.invitations.create(WS, { email: " DUP@Example.test", roleId: R.agent }, admin))).toMatchObject({
      status: 409,
      key: "invitations.pending_exists",
    });
    expect(w.prisma.$executeRaw).toHaveBeenCalled(); // the advisory lock around the check
  });

  it("accept signed in with another email is 403", async () => {
    const w = makeWorld();
    await w.invitations.create(WS, { email: "someone@example.test", roleId: R.viewer }, owner);
    const token = tokenOf(w.email.lastTo("someone@example.test")?.text);
    expect(await failure(w.invitations.acceptSignedIn(U.other, token))).toMatchObject({
      status: 403,
      key: "invitations.email_mismatch",
    });
    expect(w.db.invitation[0].acceptedAt).toBeNull();
  });

  it("accept for an existing account while signed out is 409 sign_in_required", async () => {
    const w = makeWorld();
    await w.invitations.create(WS, { email: "other@else.test", roleId: R.viewer }, owner);
    const token = tokenOf(w.email.lastTo("other@else.test")?.text);
    expect((await w.invitations.preview(token)).accountExists).toBe(true);
    expect(await failure(w.invitations.acceptWithToken({ token, password: "whatever-pass" }))).toMatchObject({
      status: 409,
      key: "invitations.sign_in_required",
    });
    // The token is not burnt: signing in and accepting works.
    const inv = w.db.invitation[0];
    expect(inv.acceptedAt).toBeNull();
    await expect(w.invitations.acceptSignedIn(U.other, token)).resolves.toMatchObject({ userId: U.other, workspaceId: WS });
    expect(w.db.workspaceMember.find((m) => m.userId === U.other && m.workspaceId === WS)).toMatchObject({ role: "viewer", roleId: R.viewer });
  });

  it("deleted role falls back to viewer with rolePending", async () => {
    const w = makeWorld();
    const inv = await w.invitations.create(WS, { email: "t@example.test", roleId: R.temp }, owner);
    const token = tokenOf(w.email.lastTo("t@example.test")?.text);
    await w.prisma.role.delete({ where: { id: R.temp } }); // FK: Invitation.roleId → SET NULL
    expect(w.db.invitation.find((i) => i.id === inv.invitation.id).roleId).toBeNull();
    const res = await w.invitations.acceptWithToken({ token, password: "s3cret-pass" });
    expect(res.rolePending).toBe(true);
    expect(w.db.workspaceMember.find((m) => m.userId === res.userId)).toMatchObject({ role: "viewer", roleId: R.viewer });
    expect(w.db.auditLog.find((a) => a.action === "invitation.accepted").meta).toMatchObject({ rolePending: true });
  });

  it("resend is limited to one a minute and five sends; accepted or revoked invites cannot be resent", async () => {
    const w = makeWorld();
    const inv = await w.invitations.create(WS, { email: "r@example.test", roleId: R.viewer }, owner);
    expect(await failure(w.invitations.resend(WS, inv.invitation.id, owner))).toMatchObject({ status: 429, key: "invitations.resend_limited" });
    for (let i = 2; i <= INVITE_RESEND_MAX; i++) {
      w.advance(INVITE_RESEND_GAP_MS + 1);
      await w.invitations.resend(WS, inv.invitation.id, owner);
    }
    w.advance(INVITE_RESEND_GAP_MS + 1);
    expect(await failure(w.invitations.resend(WS, inv.invitation.id, owner))).toMatchObject({ status: 429 });
    await w.invitations.revoke(WS, inv.invitation.id, owner);
    expect(await failure(w.invitations.resend(WS, inv.invitation.id, owner))).toMatchObject({ status: 410 });
  });

  it("list shows statuses and counts, never a token hash; a foreign invitation id is 404", async () => {
    const w = makeWorld();
    await w.invitations.create(WS, { email: "a@example.test", roleId: R.viewer }, owner);
    const b = await w.invitations.create(WS, { email: "b@example.test", roleId: R.viewer }, owner);
    await w.invitations.revoke(WS, b.invitation.id, owner);
    const pending = await w.invitations.list(WS, undefined);
    expect(pending.items.map((i) => i.email)).toEqual(["a@example.test"]);
    expect(pending.counts).toMatchObject({ pending: 1, revoked: 1, all: 2 });
    const all = await w.invitations.list(WS, "all");
    expect(all.items).toHaveLength(2);
    expect(JSON.stringify(all)).not.toMatch(/tokenHash|[0-9a-f]{64}/);
    expect(all.items[0].invitedBy).toEqual({ id: U.owner, name: "Olivia Owner" });
    expect(await failure(w.invitations.revoke("ws2", b.invitation.id, { userId: U.other }))).toMatchObject({ status: 404 });
    expect(await failure(w.invitations.resend("ws2", b.invitation.id, { userId: U.other }))).toMatchObject({ status: 404 });
  });

  it("the invitee's listing is a count only and exposes no ids", async () => {
    const w = makeWorld();
    const inv = await w.invitations.create(WS, { email: "other@else.test", roleId: R.agent }, owner);
    const mine = await w.invitations.pendingCountForUser(U.other);
    expect(mine).toEqual({ pending: 1 });
    const json = JSON.stringify(mine);
    for (const leak of [inv.invitation.id, WS, "Acme", R.agent, "Agent", w.db.invitation[0].tokenHash]) expect(json).not.toContain(leak);
    expect(await w.invitations.pendingCountForUser(U.agent)).toEqual({ pending: 0 });
    // The token-gated preview carries no invitation id either.
    expect(await w.invitations.preview(tokenOf(w.email.lastTo("other@else.test")?.text))).not.toHaveProperty("id");
  });

  it("an account with the matching email but no token cannot join (C1)", async () => {
    const w = makeWorld();
    // The attacker registered the invitee's email (no verification) and is signed in.
    w.db.user.push({ id: "u_squat", email: "cfo@acme.test", name: "Squatter", password: "h", role: "Agent", initials: "S", color: "1", status: "offline", isSuperAdmin: false });
    const inv = await w.invitations.create(WS, { email: "cfo@acme.test", roleId: R.admin }, owner);
    // Neither the invitation id, nor a guessed or empty token, gets them in.
    for (const t of [inv.invitation.id, undefined, "", "x".repeat(43)]) {
      expect(await failure(w.invitations.acceptSignedIn("u_squat", t))).toMatchObject({ status: 410, key: "invitations.invalid" });
    }
    expect(w.db.workspaceMember.some((m) => m.userId === "u_squat")).toBe(false);
    expect(w.db.invitation[0].acceptedAt).toBeNull();
  });

  it("a signed-in user with the token and the matching email joins", async () => {
    const w = makeWorld();
    await w.invitations.create(WS, { email: "Other@Else.test", roleId: R.agent }, owner);
    const token = tokenOf(w.email.lastTo("other@else.test")?.text);
    await expect(w.invitations.acceptSignedIn(U.other, token)).resolves.toEqual({ userId: U.other, workspaceId: WS, rolePending: false });
    expect(w.db.workspaceMember.find((m) => m.userId === U.other && m.workspaceId === WS)).toMatchObject({ role: "agent", roleId: R.agent });
    // Single use.
    expect(await failure(w.invitations.acceptSignedIn(U.other, token))).toMatchObject({ status: 410 });
  });

  it("resend extends expiry 7 days from the resend, never past 14 days from creation", async () => {
    const w = makeWorld();
    const inv = await w.invitations.create(WS, { email: "life@example.test", roleId: R.viewer }, owner);
    const created = inv.invitation.createdAt.getTime();
    w.advance(3 * 86_400_000);
    const r1 = await w.invitations.resend(WS, inv.invitation.id, owner);
    expect(r1.invitation.expiresAt.getTime()).toBe(created + 3 * 86_400_000 + INVITE_TTL_MS);
    w.advance(6 * 86_400_000); // day 9: 7 more days would be day 16
    const r2 = await w.invitations.resend(WS, inv.invitation.id, owner);
    expect(r2.invitation.expiresAt.getTime()).toBe(created + INVITE_MAX_LIFETIME_MS);
    w.setClock(new Date(created + INVITE_MAX_LIFETIME_MS + 1));
    expect(await failure(w.invitations.resend(WS, inv.invitation.id, owner))).toMatchObject({ status: 410, key: "invitations.invalid" });
  });

  it("a register racing the accept maps to sign_in_required, not a 500", async () => {
    const w = makeWorld();
    withRollback(w.prisma);
    await w.invitations.create(WS, { email: "race2@example.test", roleId: R.agent }, owner);
    const token = tokenOf(w.email.lastTo("race2@example.test")?.text);
    // The account check passes, then a register commits the same email before the insert.
    const create = w.prisma.user.create.getMockImplementation();
    w.prisma.user.create.mockImplementationOnce((a: unknown) => {
      w.db.user.push({ id: "u_reg", email: "race2@example.test", name: "Reg" });
      return create(a);
    });
    expect(await failure(w.invitations.acceptWithToken({ token, password: "s3cret-pass" }))).toMatchObject({
      status: 409,
      key: "invitations.sign_in_required",
    });
    // Rolled back: the token is not burnt and nobody joined.
    expect(w.db.invitation[0].acceptedAt).toBeNull();
    expect(w.db.workspaceMember.some((m) => m.userId === "u_reg")).toBe(false);
  });

  it("an invalid or malformed token always gives the same 410", async () => {
    const w = makeWorld();
    for (const t of [undefined, "", "short", "x".repeat(43), 42]) {
      expect(await failure(w.invitations.preview(t))).toMatchObject({ status: 410, key: "invitations.invalid" });
    }
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

    it("email off returns the link to the inviter once and never logs it", async () => {
      const w = makeWorld();
      const off = new FakeEmailSender(false);
      const svc = new InvitationsService(w.prisma, w.permissions, w.audit, off, w.kewySync as never);
      svc.now = () => NOW;
      const res = await svc.create(WS, { email: "copy@example.test", roleId: R.viewer }, owner);
      expect(res.emailSent).toBe(false);
      const token = tokenOf(res.link);
      // A hash link: the token never reaches a server's access log or a Referer.
      expect(res.link).toMatch(/\/#\/accept-invite\?token=[A-Za-z0-9_-]{43}$/);
      expect(off.sent).toHaveLength(0);
      // Once: nothing else ever returns it.
      const listed = await svc.list(WS, "all");
      expect(JSON.stringify(listed)).not.toContain(token);
      expect(JSON.stringify(await svc.preview(token))).not.toContain(token);
      expect(JSON.stringify(w.db)).not.toContain(token);
      expect(lines.join("\n")).not.toContain(token);
    });

    it("no token, code or password in any log line", async () => {
      const w = makeWorld();
      const secrets: string[] = ["s3cret-pass-123"];
      const inv = await w.invitations.create(WS, { email: "log@example.test", roleId: R.agent }, owner);
      secrets.push(tokenOf(w.email.lastTo("log@example.test")?.text));
      w.advance(INVITE_RESEND_GAP_MS + 1);
      await w.invitations.resend(WS, inv.invitation.id, owner);
      const token = tokenOf(w.email.lastTo("log@example.test")?.text);
      secrets.push(token);
      // A provider failure is logged without the address, link or body.
      w.email.fail = new Error(`provider echoed ${token}`);
      w.advance(INVITE_RESEND_GAP_MS + 1);
      const failed = await w.invitations.resend(WS, inv.invitation.id, owner);
      expect(failed.emailSent).toBe(false);
      w.email.fail = null;
      w.advance(INVITE_RESEND_GAP_MS + 1);
      await w.invitations.resend(WS, inv.invitation.id, owner);
      const last = tokenOf(w.email.lastTo("log@example.test")?.text);
      secrets.push(last);
      await w.invitations.acceptWithToken({ token: last, name: "Lo", password: "s3cret-pass-123" });
      await w.invitations.acceptWithToken({ token: last, password: "s3cret-pass-123" }).catch(() => undefined);
      expect(lines.length).toBeGreaterThan(0); // the failure was logged
      const all = lines.join("\n");
      for (const s of secrets) expect(all).not.toContain(s);
      for (const m of w.email.sent) expect(all).not.toContain(m.html);
      expect(all).not.toContain("log@example.test");
      // Audit meta never carries a secret either.
      expect(JSON.stringify(w.db.auditLog)).not.toMatch(/token|password|s3cret/i);
    });
  });
});
