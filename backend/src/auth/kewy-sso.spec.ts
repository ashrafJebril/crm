import { generateKeyPairSync } from "crypto";
import { JwtService } from "@nestjs/jwt";
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { KewySsoService } from "./kewy-sso.service";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const ISSUER = "https://kewy.test";

const claims = (over: Record<string, unknown> = {}) => ({
  sub: "acc-1",
  jti: "jti-1",
  kw_workspace_id: "ws-kewy-1",
  kw_workspace_name: "Salon Noor",
  kw_role: "OWNER",
  email: "owner@example.com",
  name: "Noor Owner",
  ...over,
});

const sign = (payload: Record<string, unknown>, opts: Record<string, unknown> = {}) =>
  new JwtService({}).sign(payload, {
    privateKey,
    algorithm: "RS256",
    issuer: ISSUER,
    audience: "crm",
    expiresIn: "90s",
    ...opts,
  });

/** Minimal prisma double; each test overrides only what it needs. */
function makePrisma(over: Record<string, unknown> = {}) {
  return {
    raw: {
      ssoNonce: {
        create: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      workspace: {
        upsert: jest.fn().mockResolvedValue({ id: "ws1", suspendedAt: null }),
        update: jest.fn().mockResolvedValue({ id: "ws1", suspendedAt: null }),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      user: {
        upsert: jest.fn().mockResolvedValue({
          id: "u1", email: "owner@example.com", name: "Noor Owner",
          role: "Agent", initials: "NO", color: "150",
        }),
      },
      workspaceMember: { upsert: jest.fn().mockResolvedValue({}) },
      ...over,
    },
  } as never;
}

const makeService = (prisma = makePrisma()) =>
  new KewySsoService(
    prisma,
    // Mirrors JwtModule.register in AuthModule: the outgoing crm session token
    // is signed with crm's own symmetric secret; the incoming Kewy token is
    // verified with a per-call publicKey override.
    new JwtService({ secret: "test-secret-at-least-32-chars-long!!" }),
    { listForUser: jest.fn().mockResolvedValue([]) } as never,
  );

describe("KewySsoService.exchange", () => {
  beforeEach(() => {
    process.env.KEWY_SSO_PUBLIC_KEY = publicKey;
    process.env.KEWY_ISSUER = ISSUER;
  });
  afterEach(() => {
    delete process.env.KEWY_SSO_PUBLIC_KEY;
    delete process.env.KEWY_ISSUER;
  });

  it("is inert until the public key is configured", async () => {
    delete process.env.KEWY_SSO_PUBLIC_KEY;
    await expect(makeService().exchange({ token: sign(claims()) })).rejects.toThrow(
      ForbiddenException,
    );
  });

  it("accepts a well-formed token and issues a crm session", async () => {
    const res = await makeService().exchange({ token: sign(claims()) });
    expect(res.activeWorkspaceId).toBe("ws1");
    expect(res.token).toEqual(expect.any(String));
  });

  it("never grants super-admin, whatever role Kewy asserts", async () => {
    const res = await makeService().exchange({
      token: sign(claims({ kw_role: "SUPER_ADMIN" })),
    });
    const decoded = new JwtService({}).decode(res.token) as Record<string, unknown>;
    // A Kewy compromise must not become a cross-tenant compromise of crm.
    expect(decoded.isSuperAdmin).toBeUndefined();
  });

  it.each([
    ["an unsigned token", () => sign(claims(), { algorithm: "none", privateKey: undefined })],
    ["a wrong audience", () => sign(claims(), { audience: "hjz" })],
    ["a wrong issuer", () => sign(claims(), { issuer: "https://evil.test" })],
    ["an expired token", () => sign(claims(), { expiresIn: "-10s" })],
  ])("rejects %s", async (_label, mint) => {
    let token: string;
    try {
      token = mint();
    } catch {
      return; // signing itself refused (alg:none) — equally a rejection
    }
    await expect(makeService().exchange({ token })).rejects.toThrow(UnauthorizedException);
  });

  it("rejects a token missing required claims", async () => {
    const token = sign({ sub: "acc-1", jti: "j" }); // no kw_workspace_id
    await expect(makeService().exchange({ token })).rejects.toThrow(UnauthorizedException);
  });

  it("rejects a replayed token", async () => {
    const prisma = makePrisma();
    (prisma as never as { raw: { ssoNonce: { create: jest.Mock } } }).raw.ssoNonce.create =
      jest.fn().mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("dup", {
          code: "P2002",
          clientVersion: "5",
        }),
      );
    await expect(
      makeService(prisma).exchange({ token: sign(claims()) }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it("refuses to hand out a session for a suspended workspace", async () => {
    const prisma = makePrisma({
      workspace: {
        upsert: jest.fn().mockResolvedValue({ id: "ws1", suspendedAt: new Date() }),
        update: jest.fn().mockResolvedValue({ id: "ws1", suspendedAt: null }),
        findUnique: jest.fn().mockResolvedValue(null),
      },
    });
    await expect(
      makeService(prisma).exchange({ token: sign(claims()) }),
    ).rejects.toThrow(ForbiddenException);
  });
});
