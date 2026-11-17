import { JwtService } from "@nestjs/jwt";
import { SsoService } from "./sso.service";

const HJZ_SECRET = "hjz-access-secret-for-the-sso-spec-000";

describe("HJZ SSO exchange and two-step verification (SP-26 ruling 9)", () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.AUTH_MODE = "sso";
    process.env.HJZ_JWT_ACCESS_SECRET = HJZ_SECRET;
  });
  afterEach(() => {
    process.env = { ...env };
  });

  it("sso login does not ask for totp, and the session carries sv", async () => {
    const prisma = {
      workspace: {
        upsert: jest.fn().mockResolvedValue({ id: "ws1", name: "HJZ t1", slug: "hjz-t1" }),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      user: {
        upsert: jest.fn().mockResolvedValue({
          id: "u1", email: "a@hjz.test", name: "A", role: "Agent", initials: "A", color: "150",
          twoFA: true, totpSecretEnc: "enc:v1:x", sessionVersion: 4,
        }),
      },
      workspaceMember: { upsert: jest.fn().mockResolvedValue({}) },
    };
    const jwt = new JwtService({ secret: "crm-session-secret-at-least-32-chars!!" });
    const svc = new SsoService(prisma as never, jwt, { listForUser: jest.fn().mockResolvedValue([]) } as never);
    const hjzToken = new JwtService({}).sign({ sub: "hjz-u1", tid: "t1", role: "admin" }, { secret: HJZ_SECRET });
    const res = await svc.exchange({ token: hjzToken });
    expect(res).not.toHaveProperty("twoFactorRequired");
    expect(jwt.decode(res.token)).toMatchObject({ sub: "u1", sv: 4, workspaceId: "ws1" });
    expect(JSON.stringify(res)).not.toMatch(/enc:v1|totp/);
  });
});
