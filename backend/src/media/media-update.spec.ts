import { BadRequestException, NotFoundException, ValidationPipe } from "@nestjs/common";
import { MediaService } from "./media.service";
import { MediaController } from "./media.controller";
import { UpdateMediaDto } from "./media.dto";
import { makeFakePrisma } from "../channels/test-prisma";

const MB = 1024 * 1024;
const t0 = Date.UTC(2026, 10, 1);
const at = (min: number) => new Date(t0 + min * 60_000);

function row(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    workspaceId: "ws",
    fileName: `${id}.jpg`,
    mimeType: "image/jpeg",
    sizeBytes: MB,
    storedPath: `ws/${id}.jpg`,
    storageKind: "local",
    uploadedById: "u1",
    publicToken: null,
    publicTokenExpiresAt: null,
    title: null,
    alt: null,
    tags: [],
    useWhen: null,
    approvedForAgent: false,
    createdAt: at(1),
    ...over,
  };
}

async function errOf(p: Promise<unknown>): Promise<any> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

const build = (rows: any[], restricted = false) => {
  const prisma = makeFakePrisma({ media: rows });
  prisma.message.findMany = jest.fn(async () => []);
  const perm = restricted ? { conversationScope: jest.fn(async () => ({ assigneeId: "me" })) } : undefined;
  const svc = new MediaService(prisma, { kind: "local" } as never, perm as never);
  return { prisma, svc };
};
const viewer = { userId: "me" } as never;

const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
const viaPipe = (body: unknown) => pipe.transform(body, { type: "body", metatype: UpdateMediaDto });

describe("patch media updates details and normalizes tags", () => {
  it("normalises tags, trims text and returns the updated row", async () => {
    const { svc, prisma } = build([row("m1", { alt: "keep" })]);
    const out = await svc.update("ws", "m1", { title: "  Menu ", tags: ["Menu", " menu ", "", "قائمة", "MENU"] }, viewer);
    expect(out).toMatchObject({ id: "m1", title: "Menu", tags: ["menu", "قائمة"], alt: "keep" });
    expect(prisma.db.media[0]).toMatchObject({ title: "Menu", tags: ["menu", "قائمة"], alt: "keep", useWhen: null });
  });

  it("'' clears a field to null; absent fields are untouched", async () => {
    const { svc, prisma } = build([row("m1", { title: "T", alt: "A", useWhen: "U", tags: ["x"] })]);
    await svc.update("ws", "m1", { alt: "" }, viewer);
    expect(prisma.db.media[0]).toMatchObject({ title: "T", alt: null, useWhen: "U", tags: ["x"] });
  });

  it("{} -> 400 media.no_changes", async () => {
    const { svc } = build([row("m1")]);
    const e = await errOf(svc.update("ws", "m1", {}, viewer));
    expect(e).toBeInstanceOf(BadRequestException);
    expect(e.getResponse()).toMatchObject({ message: "media.no_changes" });
  });

  it("the pipe refuses an unknown field, 21 tags, a 41-char tag, a long title and a null switch", async () => {
    for (const body of [
      { title: "x", storedPath: "ws/other.jpg" },
      { tags: Array.from({ length: 21 }, (_, i) => `t${i}`) },
      { tags: ["a".repeat(41)] },
      { title: "a".repeat(121) },
      { approvedForAgent: null },
      { approvedForAgent: "yes" },
    ]) {
      await expect(viaPipe(body)).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(viaPipe({ title: null, alt: "", tags: ["a"], useWhen: "x", approvedForAgent: true })).resolves.toBeTruthy();
  });
});

describe("approval refuses non-images, oversize and inbound files", () => {
  it.each(["application/pdf", "video/mp4", "image/webp", "image/gif"])("%s -> media.not_approvable {reason: type}", async (mimeType) => {
    const { svc, prisma } = build([row("m1", { mimeType, title: "T" })]);
    const e = await errOf(svc.update("ws", "m1", { approvedForAgent: true }, viewer));
    expect(e.getResponse()).toMatchObject({ statusCode: 400, message: "media.not_approvable", reason: "type" });
    expect(prisma.db.media[0].approvedForAgent).toBe(false);
  });

  it("a 6 MB PNG -> size; an inbound JPEG -> inbound", async () => {
    const { svc } = build([
      row("big", { mimeType: "image/png", sizeBytes: 6 * MB, title: "T" }),
      row("in", { uploadedById: null, title: "T" }),
    ]);
    expect((await errOf(svc.update("ws", "big", { approvedForAgent: true }, viewer))).getResponse()).toMatchObject({
      message: "media.not_approvable",
      reason: "size",
    });
    expect((await errOf(svc.update("ws", "in", { approvedForAgent: true }, viewer))).getResponse()).toMatchObject({
      message: "media.not_approvable",
      reason: "inbound",
    });
  });

  it("a 4 MB staff JPEG with a title is approved", async () => {
    const { svc, prisma } = build([row("m1", { sizeBytes: 4 * MB, title: "Menu" })]);
    await expect(svc.update("ws", "m1", { approvedForAgent: true }, viewer)).resolves.toMatchObject({ approvedForAgent: true });
    expect(prisma.db.media[0].approvedForAgent).toBe(true);
  });

  it("hiding a blocked file and editing details of an approved one are allowed", async () => {
    const { svc } = build([row("pdf", { mimeType: "application/pdf", approvedForAgent: true, title: "T" })]);
    await expect(svc.update("ws", "pdf", { alt: "x" }, viewer)).resolves.toMatchObject({ alt: "x" });
    await expect(svc.update("ws", "pdf", { approvedForAgent: false }, viewer)).resolves.toMatchObject({ approvedForAgent: false });
  });
});

describe("approval requires a title", () => {
  it("approving with no title -> media.title_required", async () => {
    const { svc } = build([row("m1")]);
    const e = await errOf(svc.update("ws", "m1", { approvedForAgent: true }, viewer));
    expect(e.getResponse()).toMatchObject({ statusCode: 400, message: "media.title_required" });
    // A blank title is no title.
    const e2 = await errOf(svc.update("ws", "m1", { approvedForAgent: true, title: "   " }, viewer));
    expect(e2.getResponse()).toMatchObject({ message: "media.title_required" });
  });

  it("clearing the title of an approved row -> media.title_required", async () => {
    const { svc, prisma } = build([row("m1", { title: "T", approvedForAgent: true })]);
    for (const title of ["", null]) {
      const e = await errOf(svc.update("ws", "m1", { title }, viewer));
      expect(e.getResponse()).toMatchObject({ message: "media.title_required" });
    }
    expect(prisma.db.media[0].title).toBe("T");
    // Hiding and clearing together is fine.
    await expect(svc.update("ws", "m1", { title: "", approvedForAgent: false }, viewer)).resolves.toMatchObject({
      title: null,
      approvedForAgent: false,
    });
  });

  it("title and approval in one body -> OK", async () => {
    const { svc } = build([row("m1")]);
    await expect(svc.update("ws", "m1", { title: "Menu", approvedForAgent: true }, viewer)).resolves.toMatchObject({
      title: "Menu",
      approvedForAgent: true,
    });
  });
});

describe("foreign ids return 404 on SP-17 routes", () => {
  it("PATCH with another workspace's id -> 404 Media not found, nothing written", async () => {
    const { svc, prisma } = build([row("theirs", { workspaceId: "other", title: "T" })]);
    const e = await errOf(svc.update("ws", "theirs", { approvedForAgent: true }, viewer));
    expect(e).toBeInstanceOf(NotFoundException);
    expect(e.message).toBe("Media not found");
    expect(prisma.db.media[0].approvedForAgent).toBe(false);
  });

  it("a restricted viewer patching a hidden inbound file -> 404", async () => {
    const { svc, prisma } = build([row("in", { uploadedById: null })], true);
    const e = await errOf(svc.update("ws", "in", { title: "x" }, viewer));
    expect(e).toBeInstanceOf(NotFoundException);
    expect(e.message).toBe("Media not found");
    expect(prisma.db.media[0].title).toBeNull();
  });

  it("the controller passes workspace, id, body and viewer through", async () => {
    const svc = { update: jest.fn(async () => ({ id: "m1" })) };
    const ctrl = new MediaController(svc as never);
    await ctrl.update("ws", "m1", { title: "x" } as never, viewer);
    expect(svc.update).toHaveBeenCalledWith("ws", "m1", { title: "x" }, viewer);
  });
});

describe("media list filters by q and approved and pages with the cursor", () => {
  const seed = () => [
    row("t1", { title: "Breakfast MENU", createdAt: at(1) }),
    row("a1", { alt: "A red Door", createdAt: at(2) }),
    row("u1", { useWhen: "When they ask for the Menu", createdAt: at(3) }),
    row("f1", { fileName: "menu-card.png", mimeType: "image/png", createdAt: at(4) }),
    row("g1", { tags: ["menu", "قائمة"], approvedForAgent: true, title: "x", createdAt: at(5) }),
    row("ar", { title: "قائمة الطعام", approvedForAgent: true, createdAt: at(6) }),
    row("no", { title: "Opening hours", createdAt: at(7) }),
    row("other", { workspaceId: "other", title: "menu", createdAt: at(8) }),
  ];
  const ids = (rows: any[]) => rows.map((r) => r.id);

  it("q matches title, alt, use-when and file name case-insensitively, and an exact tag", async () => {
    const { svc } = build(seed());
    expect(ids(await svc.list("ws", undefined, { q: "menu" }))).toEqual(["g1", "f1", "u1", "t1"]);
    expect(ids(await svc.list("ws", undefined, { q: "DOOR" }))).toEqual(["a1"]);
    expect(ids(await svc.list("ws", undefined, { q: "قائمة" }))).toEqual(["ar", "g1"]);
    // A tag matches exactly, not as a substring.
    expect(ids(await svc.list("ws", undefined, { q: "men" }))).toEqual(["f1", "u1", "t1"]);
  });

  it("two tokens must both match", async () => {
    const { svc } = build(seed());
    expect(ids(await svc.list("ws", undefined, { q: "menu breakfast" }))).toEqual(["t1"]);
    expect(ids(await svc.list("ws", undefined, { q: "menu door" }))).toEqual([]);
  });

  it("approved=true|false filters", async () => {
    const { svc } = build(seed());
    expect(ids(await svc.list("ws", undefined, { approved: true }))).toEqual(["ar", "g1"]);
    expect(ids(await svc.list("ws", undefined, { approved: false }))).toEqual(["no", "f1", "u1", "a1", "t1"]);
    expect(ids(await svc.list("ws", undefined, { approved: true, q: "menu" }))).toEqual(["g1"]);
  });

  it("limit=2 over 5 matching rows: three pages follow nextBefore without gaps or repeats", async () => {
    const rows = Array.from({ length: 7 }, (_, i) =>
      row(`r${i}`, { title: i % 3 === 2 ? "other" : `menu ${i}`, createdAt: at(10 + i) }),
    );
    const { svc } = build(rows);
    const seen: string[] = [];
    let before: string | undefined;
    for (let p = 0; p < 3; p++) {
      const page = await svc.listPage("ws", undefined, { q: "menu", limit: 2, before });
      seen.push(...ids(page.items));
      if (p < 2) expect(page.nextBefore).toBeTruthy();
      else expect(page.nextBefore).toBeNull();
      before = page.nextBefore ?? undefined;
    }
    expect(seen).toEqual(["r6", "r4", "r3", "r1", "r0"]);
    expect(new Set(seen).size).toBe(seen.length);
    // A cursor that does not match the filter is still a valid position.
    expect(ids((await svc.listPage("ws", undefined, { q: "menu", limit: 10, before: "r5" })).items)).toEqual(["r4", "r3", "r1", "r0"]);
  });

  it("a restricted viewer never sees a hidden inbound file, even when it matches q", async () => {
    const { svc } = build(
      [row("in", { uploadedById: null, title: "secret menu", createdAt: at(9) }), row("mine", { title: "menu", createdAt: at(1) })],
      true,
    );
    expect(ids(await svc.list("ws", viewer, { q: "menu" }))).toEqual(["mine"]);
  });
});

describe("invalid q or approved is a keyed 400", () => {
  const ctrlOf = () => {
    const svc = { listPage: jest.fn(async () => ({ items: [], nextBefore: null })) };
    return { svc, ctrl: new MediaController(svc as never) };
  };
  const res = { setHeader: jest.fn() } as never;
  const call = (ctrl: MediaController, q?: unknown, approved?: string) =>
    ctrl.list("ws", viewer, res, undefined, undefined, undefined, q as string, approved);

  it("101-char q -> {param: q}; approved=yes -> {param: approved}", () => {
    const { ctrl } = ctrlOf();
    for (const [args, param] of [
      [["a".repeat(101)], "q"],
      [[["a", "b"]], "q"],
      [[undefined, "yes"], "approved"],
      [[undefined, "TRUE"], "approved"],
    ] as const) {
      let err: any;
      try {
        call(ctrl, ...(args as unknown as [unknown, string]));
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({ message: "media.invalid_query", param });
    }
  });

  it("valid q and approved are passed on trimmed; empty q is ignored", async () => {
    const { svc, ctrl } = ctrlOf();
    await call(ctrl, `  ${"a".repeat(100)}  `, "true");
    expect(svc.listPage).toHaveBeenLastCalledWith("ws", viewer, expect.objectContaining({ q: "a".repeat(100), approved: true }));
    await call(ctrl, "   ", "false");
    const opts = (svc.listPage.mock.calls.at(-1) as unknown as [string, unknown, Record<string, unknown>])[2];
    expect("q" in opts).toBe(false);
    expect(opts.approved).toBe(false);
  });

  it("no query at all keeps the SP-13 call shape", async () => {
    const { svc, ctrl } = ctrlOf();
    await ctrl.list("ws", viewer, res);
    expect(svc.listPage).toHaveBeenCalledWith("ws", viewer, { kind: undefined, before: undefined, limit: undefined });
    const opts = (svc.listPage.mock.calls[0] as unknown as [string, unknown, Record<string, unknown>])[2];
    expect(Object.keys(opts).sort()).toEqual(["before", "kind", "limit"]);
  });
});
