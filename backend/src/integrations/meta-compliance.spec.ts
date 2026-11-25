import * as crypto from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import { MetaAppController } from "./meta-app.controller";
import { MetaComplianceService } from "./meta-compliance.service";

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function signedRequest(userId: string, secret: string): string {
  const body = b64url(JSON.stringify({ algorithm: "HMAC-SHA256", user_id: userId, issued_at: 1 }));
  return `${b64url(crypto.createHmac("sha256", secret).update(body).digest())}.${body}`;
}

type Row = { id: string; workspaceId: string; platform: string; provider: string; raw: string | null };

function makePrisma(rows: Row[]) {
  return {
    integration: {
      findMany: jest.fn(async ({ where }: { where: { provider?: string; workspaceId?: string; raw?: { contains: string } } }) =>
        rows.filter(
          (r) =>
            (!where.provider || r.provider === where.provider) &&
            (!where.workspaceId || r.workspaceId === where.workspaceId) &&
            (!where.raw || (r.raw ?? "").includes(where.raw.contains)),
        ),
      ),
      deleteMany: jest.fn(async ({ where }: { where: { id: { in: string[] }; provider: string } }) => {
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i--) {
          if (where.id.in.includes(rows[i].id) && rows[i].provider === where.provider) rows.splice(i, 1);
        }
        return { count: before - rows.length };
      }),
    },
  };
}

describe("Meta deauthorize / data-deletion callbacks", () => {
  const OLD = { ...process.env };
  let rows: Row[];
  let ctl: MetaAppController;

  beforeEach(() => {
    process.env = { ...OLD, META_APP_SECRET: "main", META_APP_SECRET_WA: "wa", BACKEND_PUBLIC_URL: "https://api.example.com" };
    delete process.env.META_TECH_PROVIDER_ENABLED;
    rows = [
      { id: "fb", workspaceId: "w1", platform: "facebook", provider: "meta", raw: JSON.stringify({ metaUserId: "111" }) },
      { id: "ig", workspaceId: "w1", platform: "instagram", provider: "meta", raw: JSON.stringify({ linkedFbPageId: "P", metaUserId: "111" }) },
      { id: "other", workspaceId: "w2", platform: "facebook", provider: "meta", raw: JSON.stringify({ metaUserId: "1112" }) },
      { id: "pasted", workspaceId: "w3", platform: "whatsapp", provider: "meta", raw: JSON.stringify({ wabaId: "X" }) },
      { id: "zernio", workspaceId: "w1", platform: "whatsapp", provider: "zernio", raw: JSON.stringify({ metaUserId: "111" }) },
    ];
    const prisma = makePrisma(rows);
    ctl = new MetaAppController(new MetaComplianceService(prisma as never), prisma as never);
  });
  afterAll(() => {
    process.env = OLD;
  });

  it("deauthorize removes only that user's Meta rows", async () => {
    await ctl.deauthorize({ signed_request: signedRequest("111", "main") });
    expect(rows.map((r) => r.id).sort()).toEqual(["other", "pasted", "zernio"]);
  });

  it("accepts requests signed by the legacy WhatsApp app", async () => {
    await ctl.deauthorize({ signed_request: signedRequest("111", "wa") });
    expect(rows.find((r) => r.id === "fb")).toBeUndefined();
  });

  it("rejects forged or missing signed_request", async () => {
    await expect(ctl.deauthorize({ signed_request: signedRequest("111", "evil") })).rejects.toBeInstanceOf(BadRequestException);
    await expect(ctl.dataDeletion({})).rejects.toBeInstanceOf(BadRequestException);
    expect(rows).toHaveLength(5);
  });

  it("data deletion returns a status url + confirmation code", async () => {
    const res = await ctl.dataDeletion({ signed_request: signedRequest("111", "main") });
    expect(res.confirmation_code).toMatch(/^[a-f0-9]{16}$/);
    expect(res.url).toBe(`https://api.example.com/api/meta/data-deletion/status?code=${res.confirmation_code}`);
    expect(rows.map((r) => r.id).sort()).toEqual(["other", "pasted", "zernio"]);
  });

  it("status page escapes the code", () => {
    const html = ctl.status('<script>alert(1)</script>abc123');
    expect(html).not.toContain("<script>");
    expect(html).toContain("Status: completed");
  });

  it("config hides everything while the switch is off but reports Zernio platforms", async () => {
    await expect(ctl.config("w1")).resolves.toEqual({
      enabled: false,
      zernio: { whatsapp: true, facebook: false, instagram: false },
    });
  });

  it("config exposes app + login configs once enabled", async () => {
    process.env.META_TECH_PROVIDER_ENABLED = "true";
    process.env.META_APP_ID = "APP";
    process.env.META_WA_CONFIG_ID = "WACFG";
    process.env.META_FB_CONFIG_ID = "FBCFG";
    await expect(ctl.config("w2")).resolves.toMatchObject({
      enabled: true,
      appId: "APP",
      waConfigId: "WACFG",
      fbConfigId: "FBCFG",
      zernio: { whatsapp: false, facebook: false, instagram: false },
    });
  });
});
