import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import * as jwt from "jsonwebtoken";
import { createHmac } from "node:crypto";
import { HjzLinkService } from "./hjz-link.service";

describe("HjzLinkService", () => {
  let raw: any;
  let svc: HjzLinkService;

  beforeEach(() => {
    process.env.HJZ_WEB_URL = "https://app.hjz.test/";
    process.env.HJZ_WEBHOOK_SECRET = "shared";
    raw = {
      workspace: { findUnique: jest.fn().mockResolvedValue({ externalTenantId: "tenant-1" }) },
      user: { findUnique: jest.fn().mockResolvedValue({ externalId: "hjz-user-7", kewyAccountId: null }) },
    };
    svc = new HjzLinkService({ raw } as never);
  });

  afterEach(() => {
    delete process.env.HJZ_WEB_URL;
    delete process.env.HJZ_WEBHOOK_SECRET;
  });

  it("signs a short ticket HJZ can verify with its derived key", async () => {
    const { url } = await svc.ticketUrl("ws-1", "u-1");
    expect(url.startsWith("https://app.hjz.test/#crm_ticket=")).toBe(true);
    const ticket = decodeURIComponent(url.split("#crm_ticket=")[1]);
    // Same derivation as HJZ's crmSsoKey().
    const key = createHmac("sha256", "shared").update("crm-sso-v1").digest("hex");
    const claims = jwt.verify(ticket, key, { algorithms: ["HS256"], issuer: "crm", audience: "hjz" }) as any;
    expect(claims).toMatchObject({ tid: "tenant-1", hjzUserId: "hjz-user-7" });
    expect(claims.exp - claims.iat).toBe(60);
    expect(typeof claims.jti).toBe("string");
  });

  it("each ticket is unique", async () => {
    const a = await svc.ticketUrl("ws-1", "u-1");
    const b = await svc.ticketUrl("ws-1", "u-1");
    expect(a.url).not.toBe(b.url);
  });

  it("refuses a user with no HJZ link", async () => {
    raw.user.findUnique.mockResolvedValue({ externalId: null, kewyAccountId: null });
    await expect(svc.ticketUrl("ws-1", "u-1")).rejects.toThrow(ConflictException);
    await expect(svc.status("ws-1", "u-1")).resolves.toEqual({ connected: true, linked: false });
  });

  it("is hidden for a workspace not connected to HJZ", async () => {
    raw.workspace.findUnique.mockResolvedValue({ externalTenantId: null });
    await expect(svc.status("ws-1", "u-1")).resolves.toEqual({ connected: false, linked: false });
    await expect(svc.ticketUrl("ws-1", "u-1")).rejects.toThrow(ServiceUnavailableException);
  });
});
