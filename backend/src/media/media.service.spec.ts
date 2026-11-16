import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { lockMediaForReference, MediaService, MAX_PDF_BYTES } from "./media.service";
import { makeFakePrisma } from "../channels/test-prisma";

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42isom")]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1]);
const PDF = Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "latin1");
const HTML = Buffer.from("<!doctype html><script>alert(1)</script>");

/** Stage bytes in a real temp file, like multer's diskStorage does. */
async function staged(bytes: Buffer): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "media-test-"));
  const p = path.join(dir, "staged-upload");
  await fsp.writeFile(p, bytes);
  return p;
}

async function gone(p: string) {
  await expect(fsp.access(p)).rejects.toBeTruthy();
}

function makeFile(over: Partial<Express.Multer.File>): Express.Multer.File {
  return {
    fieldname: "file",
    originalname: "clip.mp4",
    encoding: "7bit",
    mimetype: "video/mp4",
    size: 5 * 1024 * 1024,
    buffer: Buffer.alloc(0),
    path: "",
    destination: "",
    filename: "",
    stream: undefined as never,
    ...over,
  } as Express.Multer.File;
}

async function errOf(p: Promise<unknown>): Promise<any> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

describe("MediaService.finalizeUpload", () => {
  let storage: { kind: "local"; put: jest.Mock; getSignedUrl: jest.Mock; delete: jest.Mock };
  let prisma: { media: { create: jest.Mock } };
  let svc: MediaService;

  beforeEach(() => {
    storage = {
      kind: "local",
      put: jest.fn().mockResolvedValue({ key: "ws1/clip.mp4" }),
      getSignedUrl: jest.fn(),
      delete: jest.fn(),
    };
    prisma = { media: { create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: "m1", ...data })) } };
    svc = new MediaService(prisma as never, storage as never);
  });

  it("accepts an mp4 under the video cap and passes sourcePath to storage", async () => {
    const p = await staged(MP4);
    const row = await svc.finalizeUpload("ws1", makeFile({ path: p }), "u1");
    expect(storage.put).toHaveBeenCalledWith(expect.objectContaining({ sourcePath: p, mimeType: "video/mp4" }));
    expect(row.mimeType).toBe("video/mp4");
  });

  it("accepts video/quicktime", async () => {
    const p = await staged(Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from("ftypqt  ")]));
    await expect(
      svc.finalizeUpload("ws1", makeFile({ mimetype: "video/quicktime", originalname: "clip.mov", path: p }), "u1"),
    ).resolves.toBeTruthy();
  });

  it("rejects a video over 300MB", async () => {
    const p = await staged(MP4);
    await expect(svc.finalizeUpload("ws1", makeFile({ size: 301 * 1024 * 1024, path: p }), "u1")).rejects.toThrow(
      BadRequestException,
    );
  });

  it("rejects unsupported video types", async () => {
    const p = await staged(MP4);
    await expect(svc.finalizeUpload("ws1", makeFile({ mimetype: "video/x-msvideo", path: p }), "u1")).rejects.toThrow(
      BadRequestException,
    );
  });

  it("still enforces the 20MB image cap (25MB png rejected)", async () => {
    const p = await staged(PNG);
    await expect(
      svc.finalizeUpload("ws1", makeFile({ mimetype: "image/png", originalname: "big.png", size: 25 * 1024 * 1024, path: p }), "u1"),
    ).rejects.toThrow(BadRequestException);
  });

  it("still accepts a normal image (uses sourcePath when present)", async () => {
    const p = await staged(JPEG);
    const row = await svc.finalizeUpload(
      "ws1",
      makeFile({ mimetype: "image/jpeg", originalname: "a.jpg", size: 2 * 1024 * 1024, path: p }),
      "u1",
    );
    expect(row.mimeType).toBe("image/jpeg");
  });

  it("unlinks the staged temp file when validation rejects the upload", async () => {
    const p = await staged(Buffer.from("fake bytes"));
    await expect(svc.finalizeUpload("ws1", makeFile({ mimetype: "video/x-msvideo", path: p }), "u1")).rejects.toThrow(
      BadRequestException,
    );
    await gone(p);
  });

  it("unlinks the staged temp file after a successful upload", async () => {
    const p = await staged(MP4);
    await svc.finalizeUpload("ws1", makeFile({ path: p }), "u1");
    await gone(p);
  });

  describe("media upload sniffs type and accepts PDF", () => {
    it("a real PDF header is stored as application/pdf", async () => {
      const p = await staged(PDF);
      const row = await svc.finalizeUpload(
        "ws1",
        makeFile({ mimetype: "application/pdf", originalname: "menu.pdf", size: 2 * 1024 * 1024, path: p }),
        "u1",
      );
      expect(row).toMatchObject({ mimeType: "application/pdf", fileName: "menu.pdf", uploadedById: "u1" });
      await gone(p);
    });

    it("PNG bytes declared as application/pdf -> 400 media.type_mismatch", async () => {
      const p = await staged(PNG);
      const e = await errOf(svc.finalizeUpload("ws1", makeFile({ mimetype: "application/pdf", size: 100, path: p }), "u1"));
      expect(e).toBeInstanceOf(BadRequestException);
      expect(e.getResponse()).toMatchObject({ statusCode: 400, message: "media.type_mismatch" });
      expect(storage.put).not.toHaveBeenCalled();
      await gone(p);
    });

    it("a PDF declared as image/png -> 400 media.type_mismatch", async () => {
      const p = await staged(PDF);
      const e = await errOf(svc.finalizeUpload("ws1", makeFile({ mimetype: "image/png", size: 100, path: p }), "u1"));
      expect(e.getResponse()).toMatchObject({ statusCode: 400, message: "media.type_mismatch" });
      await gone(p);
    });

    it("a 101 MB PDF -> 400 media.too_large {limit}", async () => {
      const p = await staged(PDF);
      const e = await errOf(
        svc.finalizeUpload("ws1", makeFile({ mimetype: "application/pdf", size: 101 * 1024 * 1024, path: p }), "u1"),
      );
      expect(e.getResponse()).toMatchObject({ statusCode: 400, message: "media.too_large", limit: MAX_PDF_BYTES });
      expect(MAX_PDF_BYTES).toBe(100 * 1024 * 1024);
      await gone(p);
    });

    it("text/html (and SVG) -> 400 media.unsupported_type {allowed}", async () => {
      const p = await staged(HTML);
      const e = await errOf(svc.finalizeUpload("ws1", makeFile({ mimetype: "text/html", size: 40, path: p }), "u1"));
      expect(e.getResponse()).toMatchObject({ statusCode: 400, message: "media.unsupported_type" });
      expect(e.getResponse().allowed).toEqual(expect.arrayContaining(["image/png", "video/mp4", "application/pdf"]));
      expect(e.getResponse().allowed).not.toContain("image/svg+xml");
      await gone(p);
      const s = await staged(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"));
      const e2 = await errOf(svc.finalizeUpload("ws1", makeFile({ mimetype: "image/svg+xml", size: 40, path: s }), "u1"));
      expect(e2.getResponse()).toMatchObject({ message: "media.unsupported_type" });
      await gone(s);
    });

    it("HTML bytes declared as image/jpeg -> media.type_mismatch (the client's mime is never trusted)", async () => {
      const p = await staged(HTML);
      const e = await errOf(svc.finalizeUpload("ws1", makeFile({ mimetype: "image/jpeg", size: 40, path: p }), "u1"));
      expect(e.getResponse()).toMatchObject({ message: "media.type_mismatch" });
      await gone(p);
    });

    it("the temp file is deleted when storage fails", async () => {
      storage.put.mockRejectedValueOnce(new Error("disk full"));
      const p = await staged(PDF);
      await expect(
        svc.finalizeUpload("ws1", makeFile({ mimetype: "application/pdf", size: 100, path: p }), "u1"),
      ).rejects.toThrow("disk full");
      await gone(p);
    });

    it("sniffs a memory upload (buffer, no path)", async () => {
      const ok = await svc.finalizeUpload(
        "ws1",
        makeFile({ mimetype: "application/pdf", size: PDF.length, path: undefined as never, buffer: PDF }),
        "u1",
      );
      expect(ok.mimeType).toBe("application/pdf");
      const e = await errOf(
        svc.finalizeUpload("ws1", makeFile({ mimetype: "application/pdf", size: 16, path: undefined as never, buffer: PNG }), "u1"),
      );
      expect(e.getResponse()).toMatchObject({ message: "media.type_mismatch" });
    });

    it("no file -> 400 media.no_file", async () => {
      const e = await errOf(svc.finalizeUpload("ws1", undefined as never, "u1"));
      expect(e.getResponse()).toMatchObject({ statusCode: 400, message: "media.no_file" });
    });
  });
});

describe("ingestBuffer sniffs inbound images", () => {
  const build = () => {
    const storage = { kind: "local", put: jest.fn().mockResolvedValue({ key: "k" }), getSignedUrl: jest.fn(), delete: jest.fn() };
    const prisma = { media: { create: jest.fn(({ data }) => Promise.resolve({ id: "m1", ...data })) } };
    return { svc: new MediaService(prisma as never, storage as never), storage, prisma };
  };

  it("stores a real image with its sniffed type", async () => {
    const { svc } = build();
    expect((await svc.ingestBuffer({ workspaceId: "ws", buffer: PNG, mimeType: "image/png", fileName: "a" })).mimeType).toBe(
      "image/png",
    );
  });

  it("corrects a provider's fallback image type to the real one", async () => {
    const { svc, storage } = build();
    const row = await svc.ingestBuffer({ workspaceId: "ws", buffer: PNG, mimeType: "image/jpeg", fileName: "a" });
    expect(row.mimeType).toBe("image/png");
    expect(storage.put).toHaveBeenCalledWith(expect.objectContaining({ mimeType: "image/png" }));
  });

  it("refuses bytes that are not an image, whatever the declared type", async () => {
    const { svc, storage } = build();
    const e = await errOf(svc.ingestBuffer({ workspaceId: "ws", buffer: HTML, mimeType: "image/jpeg", fileName: "a" }));
    expect(e.getResponse()).toMatchObject({ statusCode: 400, message: "media.type_mismatch" });
    const e2 = await errOf(svc.ingestBuffer({ workspaceId: "ws", buffer: PDF, mimeType: "image/png", fileName: "a" }));
    expect(e2.getResponse()).toMatchObject({ message: "media.type_mismatch" });
    expect(storage.put).not.toHaveBeenCalled();
  });

  it("keeps the declared-type and size gates", async () => {
    const { svc } = build();
    expect((await errOf(svc.ingestBuffer({ workspaceId: "ws", buffer: PDF, mimeType: "application/pdf", fileName: "a" }))).getResponse()).toMatchObject({
      message: "media.unsupported_type",
    });
    const big = Buffer.concat([PNG, Buffer.alloc(20 * 1024 * 1024)]);
    expect((await errOf(svc.ingestBuffer({ workspaceId: "ws", buffer: big, mimeType: "image/png", fileName: "a" }))).getResponse()).toMatchObject({
      message: "media.too_large",
      limit: 20 * 1024 * 1024,
    });
  });
});

describe("media list filters by kind and pages by before", () => {
  const t0 = Date.UTC(2026, 10, 1);
  const at = (min: number) => new Date(t0 + min * 60_000);
  const seed = () =>
    makeFakePrisma({
      media: [
        { id: "img1", workspaceId: "ws", mimeType: "image/png", uploadedById: "u", createdAt: at(1) },
        { id: "vid1", workspaceId: "ws", mimeType: "video/mp4", uploadedById: "u", createdAt: at(2) },
        { id: "pdf1", workspaceId: "ws", mimeType: "application/pdf", uploadedById: "u", createdAt: at(3) },
        { id: "csv1", workspaceId: "ws", mimeType: "text/csv", uploadedById: "u", createdAt: at(4) },
        {
          id: "xlsx1",
          workspaceId: "ws",
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          uploadedById: "u",
          createdAt: at(5),
        },
        { id: "img2", workspaceId: "ws", mimeType: "image/jpeg", uploadedById: "u", createdAt: at(6) },
        // same createdAt as img2: the id breaks the tie
        { id: "img3", workspaceId: "ws", mimeType: "image/webp", uploadedById: "u", createdAt: at(6) },
        { id: "pdf2", workspaceId: "ws", mimeType: "application/pdf", uploadedById: "u", createdAt: at(7) },
        { id: "foreign", workspaceId: "other", mimeType: "image/png", uploadedById: "u", createdAt: at(8) },
      ],
    });
  const svcOf = (prisma: any) => new MediaService(prisma, { kind: "local" } as never);
  const ids = (rows: any[]) => rows.map((r) => r.id);

  it("default (no kind) is unchanged from before SP-13: images and videos only, no PDFs, no CSV/XLSX", async () => {
    const rows = await svcOf(seed()).list("ws");
    expect(ids(rows)).toEqual(["img3", "img2", "vid1", "img1"]);
    expect(rows.some((r: any) => r.mimeType === "application/pdf")).toBe(false);
  });

  it("kind=all is every library file (images, videos and PDFs), import files never", async () => {
    expect(ids(await svcOf(seed()).list("ws", undefined, { kind: "all" }))).toEqual([
      "pdf2", "img3", "img2", "pdf1", "vid1", "img1",
    ]);
  });

  it("kind filters by mime family", async () => {
    const svc = svcOf(seed());
    expect(ids(await svc.list("ws", undefined, { kind: "image" }))).toEqual(["img3", "img2", "img1"]);
    expect(ids(await svc.list("ws", undefined, { kind: "video" }))).toEqual(["vid1"]);
    expect(ids(await svc.list("ws", undefined, { kind: "document" }))).toEqual(["pdf2", "pdf1"]);
  });

  it("before is a keyset on (createdAt, id); nextBefore is set until the true end", async () => {
    const svc = svcOf(seed());
    const p1 = await svc.listPage("ws", undefined, { kind: "all", limit: 2 });
    expect(ids(p1.items)).toEqual(["pdf2", "img3"]);
    expect(p1.nextBefore).toBe("img3");
    const p2 = await svc.listPage("ws", undefined, { kind: "all", limit: 2, before: "img3" });
    expect(ids(p2.items)).toEqual(["img2", "pdf1"]);
    expect(p2.nextBefore).toBe("pdf1");
    const p3 = await svc.listPage("ws", undefined, { kind: "all", limit: 2, before: "pdf1" });
    expect(ids(p3.items)).toEqual(["vid1", "img1"]);
    // exactly `limit` rows left: still the true end, no cursor
    expect(p3.nextBefore).toBeNull();
    expect(await svc.listPage("ws", undefined, { kind: "all", limit: 2, before: "img1" })).toEqual({ items: [], nextBefore: null });
    expect(ids(await svc.list("ws", undefined, { kind: "image", before: "img3" }))).toEqual(["img2", "img1"]);
    expect((await svc.listPage("ws", undefined, { kind: "image" })).nextBefore).toBeNull();
  });

  it("an unknown or foreign cursor -> 400 media.invalid_query {param: before}", async () => {
    const svc = svcOf(seed());
    for (const before of ["nope", "foreign"]) {
      const e = await errOf(svc.list("ws", undefined, { before }));
      expect(e).toBeInstanceOf(BadRequestException);
      expect(e.getResponse()).toMatchObject({ message: "media.invalid_query", param: "before" });
    }
  });

  it("a restricted viewer still gets full pages of what they may see", async () => {
    const prisma = seed();
    // staff uploads are visible; mark three as inbound attachments nobody can see
    for (const r of prisma.db.media) if (["img3", "img2", "pdf1"].includes(r.id)) r.uploadedById = null;
    prisma.message.findMany = jest.fn(async () => []);
    const perm = { conversationScope: jest.fn(async () => ({ assigneeId: "me" })) };
    const svc = new MediaService(prisma, { kind: "local" } as never, perm as never);
    const viewer = { userId: "me" } as never;
    const p1 = await svc.listPage("ws", viewer, { kind: "all", limit: 2 });
    expect(ids(p1.items)).toEqual(["pdf2", "vid1"]);
    expect(p1.nextBefore).toBe("vid1");
    const p2 = await svc.listPage("ws", viewer, { kind: "all", limit: 2, before: "vid1" });
    expect(p2).toMatchObject({ nextBefore: null });
    expect(ids(p2.items)).toEqual(["img1"]);
  });

  it("visible rows beyond 20 x limit hidden rows are reachable by following nextBefore", async () => {
    const hidden = Array.from({ length: 50 }, (_, i) => ({
      id: `h${String(i).padStart(3, "0")}`,
      workspaceId: "ws",
      mimeType: "image/png",
      uploadedById: null,
      createdAt: new Date(Date.UTC(2026, 10, 2) + (100 - i) * 60_000),
    }));
    const prisma = makeFakePrisma({
      media: [
        ...hidden,
        { id: "old1", workspaceId: "ws", mimeType: "image/png", uploadedById: "u", createdAt: new Date(Date.UTC(2026, 10, 1)) },
      ],
    });
    prisma.message.findMany = jest.fn(async () => []);
    const perm = { conversationScope: jest.fn(async () => ({ assigneeId: "me" })) };
    const svc = new MediaService(prisma, { kind: "local" } as never, perm as never);
    const viewer = { userId: "me" } as never;
    // limit 2 x 20 scan pages = 40 raw rows < 50 hidden ones: the first page is empty, with a cursor
    const first = await svc.listPage("ws", viewer, { limit: 2 });
    expect(first.items).toEqual([]);
    expect(first.nextBefore).toBe("h039");
    const seen: string[] = [];
    let before: string | null = first.nextBefore;
    for (let i = 0; i < 5 && before; i++) {
      const page = await svc.listPage("ws", viewer, { limit: 2, before });
      seen.push(...ids(page.items));
      before = page.nextBefore;
    }
    expect(seen).toEqual(["old1"]);
    expect(before).toBeNull();
  });
});

describe("public token is extend-only", () => {
  const build = (row: Record<string, unknown> = {}) => {
    const prisma = makeFakePrisma({
      media: [{ id: "m1", workspaceId: "ws", mimeType: "image/png", publicToken: null, publicTokenExpiresAt: null, ...row }],
    });
    return { prisma, svc: new MediaService(prisma, { kind: "local" } as never) };
  };

  it("a second mint with a shorter TTL keeps the longer expiry and the same token", async () => {
    const { prisma, svc } = build();
    const t1 = await svc.mintPublicToken("ws", "m1", 7 * 24 * 3600 * 1000);
    const exp1 = prisma.db.media[0].publicTokenExpiresAt.getTime();
    const t2 = await svc.mintPublicToken("ws", "m1", 15 * 60 * 1000);
    expect(t2).toBe(t1);
    expect(prisma.db.media[0].publicTokenExpiresAt.getTime()).toBe(exp1);
  });

  it("a longer TTL extends the expiry and keeps the token", async () => {
    const { prisma, svc } = build();
    const t1 = await svc.mintPublicToken("ws", "m1", 60 * 1000);
    const exp1 = prisma.db.media[0].publicTokenExpiresAt.getTime();
    const t2 = await svc.mintPublicToken("ws", "m1", 3600 * 1000);
    expect(t2).toBe(t1);
    expect(prisma.db.media[0].publicTokenExpiresAt.getTime()).toBeGreaterThan(exp1);
  });

  it("an expired token is replaced", async () => {
    const { prisma, svc } = build({ publicToken: "old", publicTokenExpiresAt: new Date(Date.now() - 1000) });
    const t = await svc.mintPublicToken("ws", "m1", 60 * 1000);
    expect(t).not.toBe("old");
    expect(prisma.db.media[0].publicToken).toBe(t);
    expect(prisma.db.media[0].publicTokenExpiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("a foreign media id -> 404", async () => {
    const { svc } = build();
    await expect(svc.mintPublicToken("other", "m1")).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("media in use cannot be deleted", () => {
  const build = (extra: { template?: any[]; campaign?: any[] }) => {
    const prisma = makeFakePrisma({
      media: [{ id: "m1", workspaceId: "ws", mimeType: "application/pdf", storageKind: "local", storedPath: "ws/m1.pdf" }],
      template: extra.template ?? [],
      campaign: extra.campaign ?? [],
    });
    const storage = { kind: "local", delete: jest.fn(async () => undefined) };
    return { prisma, storage, svc: new MediaService(prisma, storage as never) };
  };

  it("referenced by a template header -> 409 media.in_use with the references", async () => {
    const { prisma, svc, storage } = build({
      template: [{ id: "t1", workspaceId: "ws", name: "promo", headerMediaId: "m1" }],
    });
    const e = await errOf(svc.remove("ws", "m1"));
    expect(e).toBeInstanceOf(ConflictException);
    expect(e.getResponse()).toEqual({
      statusCode: 409,
      message: "media.in_use",
      templates: [{ id: "t1", name: "promo" }],
      campaigns: [],
      // SP-09: ticket attachments are listed too (none here).
      tickets: [],
      // SP-21: knowledge sources too (none here).
      knowledge: [],
    });
    expect(prisma.db.media).toHaveLength(1);
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it("referenced by a scheduled (or draft, launching, running) campaign -> 409", async () => {
    for (const status of ["draft", "launching", "scheduled", "running"]) {
      const { svc } = build({ campaign: [{ id: "c1", workspaceId: "ws", name: "Eid", status, headerMediaId: "m1" }] });
      const e = await errOf(svc.remove("ws", "m1"));
      expect(e.getResponse()).toMatchObject({
        message: "media.in_use",
        templates: [],
        campaigns: [{ id: "c1", name: "Eid", status }],
      });
    }
  });

  it("a completed campaign does not block; the delete goes through", async () => {
    const { prisma, svc, storage } = build({
      campaign: [{ id: "c1", workspaceId: "ws", name: "Eid", status: "completed", headerMediaId: "m1" }],
    });
    await expect(svc.remove("ws", "m1")).resolves.toEqual({ ok: true });
    expect(prisma.db.media).toHaveLength(0);
    expect(storage.delete).toHaveBeenCalled();
    // FK SetNull backstop
    expect(prisma.db.campaign[0].headerMediaId).toBeNull();
  });

  it("a foreign media id is still 404", async () => {
    const { svc } = build({});
    await expect(svc.remove("other", "m1")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("checks references and deletes inside one transaction holding the media lock", async () => {
    const { prisma, svc } = build({});
    const order: string[] = [];
    prisma.$executeRaw.mockImplementation(async (strings: TemplateStringsArray, ...vals: any[]) => {
      order.push(`lock:${strings.join("?")}:${vals.join(",")}`);
      return 0;
    });
    const tplFind = prisma.template.findMany;
    prisma.template.findMany = jest.fn((a: any) => {
      order.push("refs");
      return tplFind(a);
    });
    await svc.remove("ws", "m1");
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(order[0]).toMatch(/pg_advisory_xact_lock\(hashtext\(\?\)\):media:m1$/);
    expect(order[1]).toBe("refs");
  });

  it("lockMediaForReference takes the same lock and 404s a media deleted meanwhile", async () => {
    const { prisma } = build({});
    const tx = { $executeRaw: jest.fn(async () => 0), media: prisma.media };
    await expect(lockMediaForReference(tx as never, "ws", "m1")).resolves.toBeUndefined();
    expect((tx.$executeRaw.mock.calls[0] as any[]).slice(1)).toEqual(["media:m1"]);
    await expect(lockMediaForReference(tx as never, "ws", "gone")).rejects.toBeInstanceOf(NotFoundException);
    await expect(lockMediaForReference(tx as never, "other", "m1")).rejects.toBeInstanceOf(NotFoundException);
  });
});
