import { JwtService } from "@nestjs/jwt";
import { AdminService } from "./admin.service";

describe("AdminService.impersonateWorkspace (SP-26)", () => {
  it("the support session carries the super-admin's sv and no TOTP step", async () => {
    const prisma = {
      raw: {
        user: {
          findUnique: jest.fn().mockResolvedValue({
            id: "sa", email: "sa@tkana.test", role: "Owner", isSuperAdmin: true, twoFA: true, sessionVersion: 5,
          }),
        },
        workspace: { findUnique: jest.fn().mockResolvedValue({ id: "ws1" }) },
      },
    };
    const jwt = new JwtService({ secret: "admin-spec-secret-at-least-32-chars!!" });
    const svc = new AdminService(prisma as never, jwt, {} as never);
    const res = await svc.impersonateWorkspace("sa", "ws1");
    expect(jwt.decode(res.token)).toMatchObject({ sub: "sa", workspaceId: "ws1", impersonating: true, sv: 5 });
    expect(jwt.decode(res.token)).not.toHaveProperty("isSuperAdmin");
  });
});
