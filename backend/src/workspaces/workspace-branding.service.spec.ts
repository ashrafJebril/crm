/* eslint-disable @typescript-eslint/no-explicit-any */
import { HttpException, NotFoundException } from "@nestjs/common";
import { MulterError } from "multer";
import { makeFakePrisma, withAdvisoryLocks } from "../channels/test-prisma";
import { MediaService } from "../media/media.service";
import { WorkspaceBrandingService } from "./workspace-branding.service";
import { WorkspacesService } from "./workspaces.service";
import { WorkspacesController } from "./workspaces.controller";
import { BrandingPublicController } from "./branding-public.controller";
import { mapLogoUploadError } from "./logo-upload.interceptor";
import { LOGO_CACHE_CONTROL, LOGO_MAX_BYTES } from "./brand-constants";
import { emailBrandOf, layoutBrandOf } from "./email-brand";
import { layout, button } from "../email/templates/layout";
import { renderChatPage } from "../channels/webchat/hosted-page";
import { resolveChatColor, widgetBrand } from "../channels/webchat/webchat.service";

const WS = "ws1";
const WS2 = "ws2";
const OWNER = "u_owner";

// Real file heads (the sniffer reads the first bytes).
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const pad = (head: Buffer, size: number) => Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length), 7)]);
const png = (size = 10 * 1024) => pad(PNG_HEAD, size);
const jpeg = () => pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]), 4096);
const webp = () => pad(Buffer.from("RIFF\u0000\u0010\u0000\u0000WEBPVP8 ", "latin1"), 4096);
const svg = () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
const gif = () => pad(Buffer.from("GIF89a", "latin1"), 2048);
const html = () => Buffer.from("<!doctype html><html><script>alert(1)</script></html>");

const file = (buffer: Buffer, mimetype: string, originalname = "logo.png") => ({ buffer, mimetype, originalname, size: buffer.length }) as Express.Multer.File;

function world() {
  const prisma = makeFakePrisma({
    workspace: [
      { id: WS, name: "Salon Noor", slug: "salon", timezone: "Asia/Riyadh", lang: "ar", plan: "free", logoMediaId: null, brandColor: null },
      { id: WS2, name: "Other", slug: "other", timezone: "Asia/Riyadh", lang: "en", plan: "free", logoMediaId: null, brandColor: null },
    ],
    media: [],
  } as any);
  prisma.raw = prisma;
  const locks = withAdvisoryLocks(prisma);
  let n = 0;
  const storage = {
    kind: "local",
    put: jest.fn(async () => ({ key: `ws/logo-${++n}.bin` })),
    delete: jest.fn(async () => undefined),
    resolveAbsolute: (p: string) => `/srv/uploads/${p}`,
    getSignedUrl: jest.fn(),
  };
  const media = new MediaService(prisma, storage as never);
  const audit = { record: jest.fn(async () => undefined) };
  const branding = new WorkspaceBrandingService(prisma, media, audit as never);
  const workspaces = new WorkspacesService(prisma, {} as never, {} as never, audit as never, {} as never);
  const controller = new WorkspacesController(workspaces, undefined, undefined, branding);
  const publicCtl = new BrandingPublicController(branding);
  const req = { user: { sub: OWNER, workspaceId: WS } } as any;
  prisma.workspaceMember.findUnique = jest.fn(async () => ({ userId: OWNER, workspaceId: WS, role: "owner" }));
  return { prisma, db: prisma.db as Record<string, any[]>, storage, media, audit, branding, workspaces, controller, publicCtl, req, locks };
}

async function failure(p: Promise<unknown>): Promise<{ status: number; body: any }> {
  try {
    await p;
  } catch (e) {
    return { status: (e as HttpException).getStatus(), body: (e as HttpException).getResponse() };
  }
  throw new Error("expected a refusal");
}

function fakeRes() {
  const headers: Record<string, string> = {};
  return { headers, setHeader: jest.fn((k: string, v: string) => (headers[k.toLowerCase()] = v)), sendFile: jest.fn(), destroy: jest.fn() } as any;
}

describe("WorkspaceBrandingService", () => {
  it("logo upload validates type/size", async () => {
    const w = world();
    // A real PNG of 10 KB: stored, current, the DTO carries its public URL.
    const dto: any = await w.controller.uploadLogo(WS, file(png(), "image/png"), w.req);
    const id = w.db.workspace.find((x) => x.id === WS).logoMediaId;
    expect(id).toBeTruthy();
    expect(dto.logoUrl).toBe(`/api/branding/${WS}/logo/${id}`);
    expect(w.db.media.find((m) => m.id === id)).toMatchObject({ purpose: "brand_logo", mimeType: "image/png", sizeBytes: 10 * 1024, uploadedById: OWNER, workspaceId: WS });
    expect(w.audit.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "workspace.branding_updated", meta: { fields: ["logo"] } }));
    // A JPEG and a WebP: accepted.
    await w.branding.uploadLogo(WS, file(jpeg(), "image/jpeg", "logo.jpg"), { userId: OWNER });
    await w.branding.uploadLogo(WS, file(webp(), "image/webp", "logo.webp"), { userId: OWNER });
    expect(w.db.media.find((m) => m.id === w.db.workspace[0].logoMediaId).mimeType).toBe("image/webp");
    const puts = w.storage.put.mock.calls.length;
    expect(puts).toBe(3);

    // Refusals: nothing is stored.
    const allowed = ["image/png", "image/jpeg", "image/webp"];
    expect(await failure(w.branding.uploadLogo(WS, file(svg(), "image/svg+xml", "logo.svg"), { userId: OWNER }))).toEqual({
      status: 400,
      body: { statusCode: 400, message: "media.unsupported_type", allowed },
    });
    expect(await failure(w.branding.uploadLogo(WS, file(gif(), "image/gif", "logo.gif"), { userId: OWNER }))).toMatchObject({ status: 400, body: { message: "media.unsupported_type" } });
    expect(await failure(w.branding.uploadLogo(WS, file(png(LOGO_MAX_BYTES + 1), "image/png"), { userId: OWNER }))).toEqual({
      status: 400,
      body: { statusCode: 400, message: "media.too_large", limit: 2097152 },
    });
    expect(await failure(w.branding.uploadLogo(WS, file(html(), "image/png"), { userId: OWNER }))).toMatchObject({ status: 400, body: { message: "media.type_mismatch" } });
    expect(await failure(w.branding.uploadLogo(WS, undefined, { userId: OWNER }))).toMatchObject({ status: 400, body: { message: "media.no_file" } });
    expect(w.storage.put.mock.calls.length).toBe(puts);
    // Only the current logo is left (the replaced PNG and JPEG were deleted after commit).
    expect(w.db.media).toHaveLength(1);
    expect(w.storage.delete).toHaveBeenCalledTimes(2);
  });

  it("svg and html-as-png are refused (also through the controller with the multer limits)", async () => {
    const w = world();
    expect(await failure(w.controller.uploadLogo(WS, file(svg(), "image/svg+xml", "x.svg"), w.req))).toMatchObject({ status: 400, body: { message: "media.unsupported_type" } });
    expect(await failure(w.controller.uploadLogo(WS, file(html(), "image/png", "x.png"), w.req))).toMatchObject({ status: 400, body: { message: "media.type_mismatch" } });
    expect(await failure(w.controller.uploadLogo(WS, file(svg(), "image/png", "x.png"), w.req))).toMatchObject({ status: 400, body: { message: "media.type_mismatch" } });
    // multer's own limit (2 MB) answers with the same key, and a missing file part is no_file.
    expect(mapLogoUploadError(new MulterError("LIMIT_FILE_SIZE")).getResponse()).toEqual({ statusCode: 400, message: "media.too_large", limit: LOGO_MAX_BYTES });
    expect(mapLogoUploadError(new MulterError("LIMIT_UNEXPECTED_FILE")).getResponse()).toMatchObject({ message: "media.no_file" });
    expect(w.storage.put).not.toHaveBeenCalled();
    expect(w.db.workspace[0].logoMediaId).toBeNull();
    // Another workspace's id in the path is refused before anything (the existing authorize()).
    expect(await failure(w.controller.uploadLogo(WS2, file(png(), "image/png"), w.req))).toMatchObject({ status: 400 });
  });

  it("public logo served with nosniff and immutable cache", async () => {
    const w = world();
    await w.branding.uploadLogo(WS, file(png(), "image/png"), { userId: OWNER });
    const id = w.db.workspace[0].logoMediaId;
    const res = fakeRes();
    await w.publicCtl.logo(WS, id, res);
    expect(res.sendFile).toHaveBeenCalledWith(`/srv/uploads/${w.db.media[0].storedPath}`);
    expect(res.headers).toMatchObject({
      "content-type": "image/png",
      "x-content-type-options": "nosniff",
      "cache-control": LOGO_CACHE_CONTROL,
      "content-security-policy": "default-src 'none'",
    });
    expect(res.headers["content-disposition"]).toBeUndefined();
  });

  it("public logo route 404 for non-logo media", async () => {
    const w = world();
    // A library image of the same workspace.
    const lib = await w.media.finalizeUpload(WS, file(png(), "image/png", "photo.png"), OWNER);
    await w.branding.uploadLogo(WS, file(png(), "image/png"), { userId: OWNER });
    await w.branding.uploadLogo(WS2, file(png(), "image/png"), { userId: OWNER });
    const foreignLogo = w.db.workspace.find((x) => x.id === WS2).logoMediaId;
    for (const [ws, id] of [
      [WS, lib.id],
      [WS, foreignLogo],
      [WS, "nope"],
      ["no-such-ws", foreignLogo],
      [WS, ""],
    ]) {
      const res = fakeRes();
      await expect(w.publicCtl.logo(ws, id, res)).rejects.toBeInstanceOf(NotFoundException);
      expect(res.sendFile).not.toHaveBeenCalled();
    }
  });

  it("old logo id is 404 after replace", async () => {
    const w = world();
    await w.branding.uploadLogo(WS, file(png(), "image/png"), { userId: OWNER });
    const old = w.db.workspace[0].logoMediaId;
    await w.branding.uploadLogo(WS, file(jpeg(), "image/jpeg"), { userId: OWNER });
    const cur = w.db.workspace[0].logoMediaId;
    expect(cur).not.toBe(old);
    await expect(w.publicCtl.logo(WS, old, fakeRes())).rejects.toBeInstanceOf(NotFoundException);
    await w.publicCtl.logo(WS, cur, fakeRes());
    // Remove: the logo goes, its URL is 404 and the DTO has no logo.
    const dto: any = await w.controller.removeLogo(WS, w.req);
    expect(dto.logoUrl).toBeNull();
    expect(w.db.media).toHaveLength(0);
    await expect(w.publicCtl.logo(WS, cur, fakeRes())).rejects.toBeInstanceOf(NotFoundException);
  });

  it("concurrent logo uploads leave one current logo", async () => {
    const w = world();
    await Promise.all([
      w.branding.uploadLogo(WS, file(png(), "image/png", "a.png"), { userId: OWNER }),
      w.branding.uploadLogo(WS, file(jpeg(), "image/jpeg", "b.jpg"), { userId: OWNER }),
    ]);
    const cur = w.db.workspace[0].logoMediaId;
    expect(w.db.media.map((m) => m.id)).toEqual([cur]);
    expect(w.storage.delete).toHaveBeenCalledTimes(1);
    // Both took the workspace's logo lock.
    expect(w.locks.order.filter((k) => k.includes(`workspace-logo:${WS}`))).toHaveLength(2);
  });

  it("deleting the current logo from the library is 409", async () => {
    const w = world();
    await w.branding.uploadLogo(WS, file(png(), "image/png"), { userId: OWNER });
    const id = w.db.workspace[0].logoMediaId;
    expect(await failure(w.media.remove(WS, id))).toEqual({
      status: 409,
      body: { statusCode: 409, message: "media.in_use", templates: [], campaigns: [], tickets: [], knowledge: [], workspaces: [{ id: WS }] },
    });
    expect(w.db.media).toHaveLength(1);
    // A library file still deletes with the old body shape.
    const lib = await w.media.finalizeUpload(WS, file(png(), "image/png", "photo.png"), OWNER);
    await expect(w.media.remove(WS, lib.id)).resolves.toEqual({ ok: true });
  });

  it("logo is not in the library or the agent photos", async () => {
    const w = world();
    const lib = await w.media.finalizeUpload(WS, file(png(), "image/png", "photo.png"), OWNER);
    await w.branding.uploadLogo(WS, file(png(), "image/png"), { userId: OWNER });
    const logo = w.db.workspace[0].logoMediaId;
    // Even approved for the agent, a logo is never offered.
    for (const m of w.db.media) Object.assign(m, { approvedForAgent: true, title: "x", tags: [] });
    expect((await w.media.listPage(WS)).items.map((m: any) => m.id)).toEqual([lib.id]);
    w.media.resolveExternalUrl = jest.fn(async () => "https://cdn.example/x") as never;
    const photos = await w.media.listForAgent(WS);
    expect(photos.photos.map((p) => p.id)).toEqual([lib.id]);
    expect(photos.photos.map((p) => p.id)).not.toContain(logo);
  });
});

describe("workspace brand colour (PATCH /workspaces/:id)", () => {
  it("brand colour normalised and validated", async () => {
    const w = world();
    const r: any = await w.workspaces.update(WS, { brandColor: "#ABC" }, { userId: OWNER });
    expect(r.brandColor).toBe("#aabbcc");
    expect(w.db.workspace[0].brandColor).toBe("#aabbcc");
    for (const bad of ["red", "#12345", "#gggggg"]) {
      expect(await failure(w.workspaces.update(WS, { brandColor: bad }, { userId: OWNER }))).toEqual({
        status: 400,
        body: { statusCode: 400, message: "workspaces.invalid_brand_color" },
      });
    }
    expect(w.db.workspace[0].brandColor).toBe("#aabbcc");
    await w.workspaces.update(WS, { brandColor: null }, { userId: OWNER });
    expect(w.db.workspace[0].brandColor).toBeNull();
    // Leaving it out keeps it.
    await w.workspaces.update(WS, { brandColor: "#0EA5E9" }, { userId: OWNER });
    await w.workspaces.update(WS, { name: "Salon" }, { userId: OWNER });
    expect(w.db.workspace[0].brandColor).toBe("#0ea5e9");
    // The workspace DTO lists carry logoUrl and a safe colour.
    expect(await w.workspaces.get(WS)).toMatchObject({ logoUrl: null, brandColor: "#0ea5e9" });
  });
});

describe("chat page and email branding", () => {
  it("chat colour precedence channel > workspace > default", () => {
    const ws = { id: WS, name: "Salon", logoMediaId: null, brandColor: "#5b2d8e" };
    expect(resolveChatColor("#0ea5e9", widgetBrand(ws))).toBe("#0ea5e9");
    expect(resolveChatColor(null, widgetBrand(ws))).toBe("#5b2d8e");
    expect(resolveChatColor(null, widgetBrand({ ...ws, brandColor: null }))).toBe("#111827");
    expect(resolveChatColor(null, widgetBrand({ ...ws, brandColor: "url(evil)" }))).toBe("#111827");
    expect(resolveChatColor(null, null)).toBe("#111827");
  });

  it("hosted page shows the logo only when set", () => {
    const base = { channel: { id: "ch1", displayName: "Shop", config: {} }, lang: "en" as const, embed: false, nonce: "n0", apiOrigin: "https://api.example" };
    const without = renderChatPage({ ...base, brand: { logoUrl: null, color: "#5b2d8e" } });
    expect(without.html).not.toContain("<img");
    expect(without.html).toContain(":root{--wc:#5b2d8e;");
    const withLogo = renderChatPage({ ...base, brand: { logoUrl: "/api/branding/ws1/logo/m1", color: null } });
    expect(withLogo.html).toContain('<header class="wc-head"><img class="wc-logo" src="/api/branding/ws1/logo/m1" alt="" width="28" height="28">');
    expect(withLogo.html).toContain(":root{--wc:#111827;");
    // The CSP is unchanged (img-src 'self' covers the same-origin logo).
    expect(withLogo.csp).toBe(without.csp);
    expect(withLogo.csp).toContain("img-src 'self' data:");
    // Anything that is not the logo route, and any non-hex colour, never reaches the page.
    const evil = renderChatPage({ ...base, brand: { logoUrl: 'https://evil.example/x.png" onerror="alert(1)', color: "red;}body{x" } });
    expect(evil.html).not.toContain("<img");
    expect(evil.html).not.toContain("evil");
    expect(evil.html).toContain(":root{--wc:#111827;");
  });

  it("email layout renders logo and colour bar", () => {
    const ws = { id: WS, name: "Salon <Noor>", logoMediaId: "m1", brandColor: "#C9A55A" };
    expect(emailBrandOf(ws, "https://api.kewy.example/")).toEqual({
      name: "Salon <Noor>",
      logoUrl: "https://api.kewy.example/api/branding/ws1/logo/m1",
      color: "#c9a55a",
      ink: "#111111",
    });
    // No public base URL → no logo (an email cannot load a relative URL).
    expect(emailBrandOf(ws, "").logoUrl).toBeNull();
    const prev = process.env.BACKEND_PUBLIC_URL;
    process.env.BACKEND_PUBLIC_URL = "https://api.kewy.example";
    try {
      const brand = layoutBrandOf(ws)!;
      const html = layout({ lang: "en", title: "Invite", bodyHtml: "<p>Hi</p>", brand });
      expect(html).toContain('<div style="height:4px;background:#c9a55a;');
      expect(html).toContain('<img src="https://api.kewy.example/api/branding/ws1/logo/m1" alt="Salon &lt;Noor&gt;" style="display:block;max-width:120px;max-height:40px;');
      // The button text uses the higher-contrast ink on the brand colour.
      expect(button("https://app.example/#/x", "Accept", brand)).toContain("background:#c9a55a;color:#111111;");
      // Without a logo: the name as text; without a colour: the default bar.
      const plain = layout({ lang: "ar", title: "x", bodyHtml: "", brand: layoutBrandOf({ id: WS, name: "Salon", logoMediaId: null, brandColor: null }) });
      expect(plain).not.toContain("<img");
      expect(plain).toContain("height:4px;background:#0f766e;");
      // A tampered brand never injects.
      const bad = layout({ lang: "en", title: "x", bodyHtml: "", brand: { name: "n", color: "red;x", logoUrl: 'javascript:alert(1)' } });
      expect(bad).not.toContain("javascript:");
      expect(bad).not.toContain("red;x");
    } finally {
      if (prev === undefined) delete process.env.BACKEND_PUBLIC_URL;
      else process.env.BACKEND_PUBLIC_URL = prev;
    }
  });
});
