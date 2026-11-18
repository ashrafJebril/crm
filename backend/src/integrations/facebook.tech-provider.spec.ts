import { ConflictException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { FacebookController } from "./facebook.controller";
import { FacebookService } from "./facebook.service";

type Row = { id: string; provider: string; platform: string; workspaceId: string; raw?: string | null };

function makePrisma(rows: Row[]) {
  const match = (where: Record<string, unknown>) =>
    rows.find((r) => Object.entries(where).every(([k, v]) => (r as Record<string, unknown>)[k] === v)) ?? null;
  return {
    integration: {
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => match(where)),
      create: jest.fn(async ({ data }: { data: Row }) => ({ ...data, id: "new" })),
      update: jest.fn(async ({ data }: { data: Row }) => data),
    },
  };
}

function mockGraph(routes: Array<[RegExp, unknown]>) {
  global.fetch = jest.fn(async (url: string) => {
    const r = routes.find(([re]) => re.test(url));
    if (!r) throw new Error(`unexpected fetch ${url}`);
    return { ok: true, status: 200, text: async () => JSON.stringify(r[1]) } as Response;
  }) as unknown as typeof fetch;
}

const userTokenGraph: Array<[RegExp, unknown]> = [
  [/\/me\/accounts/, { data: [{ id: "PAGE1", name: "Acme", access_token: "PAGE_TOK", tasks: ["MANAGE"] }] }],
  [/\/me\?fields=id,name/, { id: "USER9", name: "Owner" }],
  [/fb_exchange_token/, { access_token: "PAGE_LL", expires_in: 5000 }],
  [/subscribed_apps/, { success: true }],
  [/fields=instagram_business_account/, { instagram_business_account: { id: "IG1" } }],
  [/\/IG1\?fields=/, { id: "IG1", username: "acme" }],
];

describe("FacebookService.connect (Tech Provider)", () => {
  const OLD = { ...process.env };
  beforeEach(() => {
    process.env = { ...OLD, META_APP_ID: "main-id", META_APP_SECRET: "main-secret" };
  });
  afterAll(() => {
    process.env = OLD;
  });

  it("refuses when Facebook is connected through Zernio", async () => {
    const prisma = makePrisma([{ id: "z", provider: "zernio", platform: "facebook", workspaceId: "ws1" }]);
    const fb = new FacebookService(prisma as never, {} as never);
    mockGraph(userTokenGraph);
    await expect(fb.connect("ws1", "USER_TOK")).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.integration.create).not.toHaveBeenCalled();
  });

  it("stores the app-scoped user id on the FB and IG rows", async () => {
    const prisma = makePrisma([]);
    const fb = new FacebookService(prisma as never, {} as never);
    mockGraph(userTokenGraph);
    await fb.connect("ws1", "USER_TOK", { connectedVia: "login_for_business" });

    const [fbRow, igRow] = prisma.integration.create.mock.calls.map((c) => c[0].data as unknown as { platform: string; raw: string });
    expect(fbRow.platform).toBe("facebook");
    expect(JSON.parse(fbRow.raw)).toMatchObject({ metaUserId: "USER9", connectedVia: "login_for_business" });
    expect(igRow.platform).toBe("instagram");
    expect(JSON.parse(igRow.raw)).toMatchObject({ linkedFbPageId: "PAGE1", metaUserId: "USER9" });
  });

  it("leaves a Zernio-owned Instagram row alone", async () => {
    const prisma = makePrisma([{ id: "zi", provider: "zernio", platform: "instagram", workspaceId: "ws1" }]);
    const fb = new FacebookService(prisma as never, {} as never);
    mockGraph(userTokenGraph);
    const res = await fb.connect("ws1", "USER_TOK");
    expect(res.instagram).toEqual({ connected: false });
    expect(prisma.integration.update).not.toHaveBeenCalled();
    expect(prisma.integration.create.mock.calls.map((c) => (c[0].data as Row).platform)).toEqual(["facebook"]);
  });
});

describe("FacebookController.oauthStart", () => {
  const OLD = { ...process.env };
  const jwt = new JwtService({ secret: "test" });
  const ctl = new FacebookController({} as never, jwt);
  beforeEach(() => {
    process.env = { ...OLD, META_APP_ID: "main-id", META_FB_CONFIG_ID: "CFG1" };
    delete process.env.META_TECH_PROVIDER_ENABLED;
  });
  afterAll(() => {
    process.env = OLD;
  });

  it("keeps the scope-based dialog while the switch is off", () => {
    const { url } = ctl.oauthStart("ws1") as { url: string };
    const q = new URL(url).searchParams;
    expect(q.get("scope")).toContain("pages_messaging");
    expect(q.get("config_id")).toBeNull();
  });

  it("uses Login for Business config_id once the switch is on", () => {
    process.env.META_TECH_PROVIDER_ENABLED = "true";
    const { url } = ctl.oauthStart("ws1") as { url: string };
    const q = new URL(url).searchParams;
    expect(q.get("config_id")).toBe("CFG1");
    expect(q.get("scope")).toBeNull();
    expect(jwt.verify<{ lfb: boolean }>(q.get("state")!).lfb).toBe(true);
  });
});
