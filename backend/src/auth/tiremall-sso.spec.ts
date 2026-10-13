import { randomUUID } from "crypto";
import { JwtService } from "@nestjs/jwt";
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { TiremallSsoService } from "./tiremall-sso.service";

const SECRET = "tiremall-test-secret-at-least-32-chars!!";

const claims = (over: Record<string, unknown> = {}) => ({
  sub: "7",
  role: "ADMIN",
  email: "a@tiremall.iq",
  name: "Ashraf A",
  jti: randomUUID(),
  ...over,
});

const sign = (payload: Record<string, unknown>, opts: Record<string, unknown> = {}) =>
  new JwtService({}).sign(payload, {
    secret: SECRET,
    algorithm: "HS256",
    issuer: "tiremall",
    audience: "kewy-crm",
    expiresIn: "60s",
    ...opts,
  });

function makePrisma(over: Record<string, unknown> = {}) {
  return {
    raw: {
      ssoNonce: {
        create: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      workspace: {
        upsert: jest.fn().mockResolvedValue({ id: "ws1", suspendedAt: null }),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      user: {
        upsert: jest.fn().mockResolvedValue({
          id: "u1", email: "a@tiremall.iq", name: "Ashraf A",
          role: "Agent", initials: "AA", color: "150",
        }),
      },
      workspaceMember: { upsert: jest.fn().mockResolvedValue({}) },
      ...over,
    },
  };
}

const makeService = (prisma: ReturnType<typeof makePrisma> = makePrisma()) =>
  new TiremallSsoService(
    prisma as never,
    new JwtService({ secret: "crm-session-secret-at-least-32-chars!!" }),
    { listForUser: jest.fn().mockResolvedValue([]) } as never,
  );

describe("TiremallSsoService.exchange", () => {
  beforeEach(() => {
    process.env.TIREMALL_SSO_SECRET = SECRET;
  });
  afterEach(() => {
    delete process.env.TIREMALL_SSO_SECRET;
  });

  it("is inert until the secret is configured", async () => {
    delete process.env.TIREMALL_SSO_SECRET;
    await expect(makeService().exchange({ token: sign(claims()) })).rejects.toThrow(
      ForbiddenException,
    );
  });

  it("upserts the fixed workspace and the user, admin member, issues a session", async () => {
    const prisma = makePrisma();
    const res = await makeService(prisma).exchange({ token: sign(claims()) });
    const ws = prisma.raw.workspace.upsert.mock.calls[0][0];
    expect(ws.where).toEqual({ tiremallTenantId: "tiremall" });
    expect(ws.create).toMatchObject({
      name: "Tiremall",
      slug: "tiremall",
      tiremallTenantId: "tiremall",
    });
    expect(prisma.raw.user.upsert.mock.calls[0][0].where).toEqual({ tiremallUserId: "7" });
    expect(prisma.raw.workspaceMember.upsert.mock.calls[0][0].create.role).toBe("admin");
    expect(res.token).toBe(res.accessToken);
    expect(res.activeWorkspaceId).toBe("ws1");
  });

  it.each([
    ["AGENT", "agent"],
    [undefined, "agent"],
  ])("maps role %s to %s", async (role, expected) => {
    const prisma = makePrisma();
    await makeService(prisma).exchange({ token: sign(claims({ role })) });
    expect(prisma.raw.workspaceMember.upsert.mock.calls[0][0].create.role).toBe(expected);
  });

  it.each([
    ["a wrong secret", () => sign(claims(), { secret: "x".repeat(40) })],
    ["a wrong audience", () => sign(claims(), { audience: "crm" })],
    ["a wrong issuer", () => sign(claims(), { issuer: "evil" })],
    ["an expired token", () => sign(claims(), { expiresIn: "-10s" })],
    ["an HS512 token", () => sign(claims(), { algorithm: "HS512" })],
    [
      "an unsigned token",
      () => {
        const b = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
        return `${b({ alg: "none", typ: "JWT" })}.${b({
          ...claims(), iss: "tiremall", aud: "kewy-crm",
          exp: Math.floor(Date.now() / 1000) + 60,
        })}.`;
      },
    ],
    [
      "an hjz-shaped token",
      () =>
        new JwtService({}).sign(
          { sub: "7", tid: "t1", jti: randomUUID() },
          { secret: SECRET, algorithm: "HS256", expiresIn: "60s" },
        ),
    ],
  ])("rejects %s", async (_l, mint) => {
    await expect(makeService().exchange({ token: mint() })).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it.each([
    ["sub", { sub: undefined }],
    ["jti", { jti: undefined }],
  ])("rejects a token missing %s", async (_l, over) => {
    await expect(
      makeService().exchange({ token: sign(claims(over)) }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it("rejects a replayed token", async () => {
    const prisma = makePrisma();
    prisma.raw.ssoNonce.create = jest.fn().mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "5" }),
    );
    await expect(
      makeService(prisma).exchange({ token: sign(claims()) }),
    ).rejects.toThrow(/already been used/);
  });

  it("refuses a suspended workspace", async () => {
    const prisma = makePrisma();
    prisma.raw.workspace.upsert = jest
      .fn()
      .mockResolvedValue({ id: "ws1", suspendedAt: new Date() });
    await expect(
      makeService(prisma).exchange({ token: sign(claims()) }),
    ).rejects.toThrow(ForbiddenException);
  });
});
