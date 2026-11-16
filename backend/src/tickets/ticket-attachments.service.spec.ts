import { Logger, NotFoundException } from "@nestjs/common";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { makeFakePrisma } from "../channels/test-prisma";
import { MediaService } from "../media/media.service";
import { PermissionService } from "../permissions/permission.service";
import { TICKET_ATTACHMENT_TX_OPTIONS, TicketAttachmentsService, mediaIdsInAttach } from "./ticket-attachments.service";
import { TICKET_ATTACHMENTS_MAX } from "./ticket-fields";

const A = "wsA";
const B = "wsB";
const OWNER = "u-owner";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const HTML = Buffer.from("<!doctype html><script>alert(1)</script>");

async function errOf(p: Promise<unknown>): Promise<any> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

/** Stage bytes in a real temp file, like multer's diskStorage does. */
async function staged(bytes: Buffer): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ticket-att-"));
  const p = path.join(dir, "staged-upload");
  await fsp.writeFile(p, bytes);
  return p;
}

function upload(over: Partial<Express.Multer.File>): Express.Multer.File {
  return {
    fieldname: "file",
    originalname: "photo.png",
    encoding: "7bit",
    mimetype: "image/png",
    size: PNG.length,
    buffer: Buffer.alloc(0),
    path: "",
    destination: "",
    filename: "",
    stream: undefined as never,
    ...over,
  } as Express.Multer.File;
}

const media = (id: string, ws: string, over: Record<string, unknown> = {}) => ({
  id,
  workspaceId: ws,
  fileName: `${id}.jpg`,
  mimeType: "image/jpeg",
  sizeBytes: 1234,
  storedPath: `${ws}/secret-key-${id}.jpg`,
  storageKind: "local",
  uploadedById: null,
  createdAt: new Date("2026-11-15T10:00:00Z"),
  ...over,
});
const msg = (id: string, ws: string, conversationId: string, from: string, attach: string | null, min = 0) => ({
  id,
  workspaceId: ws,
  conversationId,
  from,
  body: "",
  t: "10:00",
  attach,
  createdAt: new Date(Date.UTC(2026, 10, 15, 10, min)),
});

/**
 * Workspace A: ticket tA (conversation cA, assigned to someone else), tA2 (no
 * conversation); workspace B: ticket tB. Media: md-cust on an inbound message
 * of cA; md-out on an outbound message of cA; md-other inbound on another
 * conversation; md-staff a staff upload referenced inbound; md-b in B.
 */
function world() {
  const storageCalls: string[] = [];
  const storage = {
    kind: "local",
    resolveAbsolute: jest.fn((p: string) => {
      storageCalls.push(`resolve:${p}`);
      return path.join(os.tmpdir(), "never-read", p);
    }),
    getSignedUrl: jest.fn(async (p: string) => {
      storageCalls.push(`sign:${p}`);
      return `https://bucket.example/${p}?X-Amz-Signature=sig`;
    }),
    put: jest.fn(async (input: any) => {
      storageCalls.push("put");
      return { key: `${input.workspaceId}/new-${input.originalFilename}` };
    }),
    delete: jest.fn(async (p: string) => {
      storageCalls.push(`delete:${p}`);
    }),
  };
  const prisma = makeFakePrisma({
    workspace: [{ id: A }, { id: B }],
    user: [{ id: OWNER, name: "Owner" }, { id: "me", name: "Me" }],
    role: [
      { id: "r-owner", workspaceId: A, key: "owner", isSystem: true, name: "Owner", nameAr: "Owner", permissions: { "*": ["*"] }, conversationVisibility: "all" },
      { id: "r-assigned", workspaceId: A, key: null, isSystem: false, name: "A", nameAr: "A", permissions: { tickets: ["view", "update"], conversations: ["view"] }, conversationVisibility: "assigned" },
    ],
    workspaceMember: [
      { id: "wm1", workspaceId: A, userId: OWNER, role: "owner", roleId: null },
      { id: "wm2", workspaceId: A, userId: "me", role: "custom", roleId: "r-assigned" },
    ],
    conversation: [
      { id: "cA", workspaceId: A, contactId: "ct", channel: "whatsapp", assigneeId: "someone" },
      { id: "cA2", workspaceId: A, contactId: "ct", channel: "whatsapp", assigneeId: null },
      { id: "cB", workspaceId: B, contactId: "ctB", channel: "whatsapp", assigneeId: null },
    ],
    message: [
      msg("m-in", A, "cA", "them", "md-cust", 1),
      msg("m-in-url", A, "cA", "them", "http://x/api/media/md-url0001/public?token=t", 2),
      msg("m-out", A, "cA", "human", "md-out", 3),
      msg("m-staff", A, "cA", "them", "md-staff", 4),
      msg("m-other", A, "cA2", "them", "md-other", 5),
      msg("m-b", B, "cB", "them", "md-b", 6),
      msg("m-b-in-a", A, "cA", "them", "md-b", 7),
    ],
    media: [
      media("md-cust", A),
      media("md-url0001", A),
      media("md-out", A),
      media("md-staff", A, { uploadedById: OWNER }),
      media("md-other", A),
      media("md-b", B),
    ],
    pipeline: [{ id: "pl", workspaceId: A }],
    ticket: [
      { id: "tA", workspaceId: A, number: 7, pipelineId: "pl", stageId: "s", contactId: "ct", conversationId: "cA", title: "T" },
      { id: "tA2", workspaceId: A, number: 8, pipelineId: "pl", stageId: "s", contactId: "ct", conversationId: null, title: "T2" },
      { id: "tB", workspaceId: B, number: 1, pipelineId: "plB", stageId: "sB", contactId: "ctB", conversationId: "cB", title: "TB" },
    ],
    ticketAttachment: [],
  });
  const perm = new PermissionService(prisma);
  const mediaSvc = new MediaService(prisma, storage as never, perm);
  const svc = new TicketAttachmentsService(prisma, mediaSvc, perm);
  return { prisma, storage, storageCalls, perm, mediaSvc, svc };
}

const owner = { userId: OWNER };

function fakeRes() {
  const res: any = {
    headers: {} as Record<string, string>,
    setHeader: jest.fn((k: string, v: string) => (res.headers[k.toLowerCase()] = v)),
    sendFile: jest.fn(),
    destroy: jest.fn(),
  };
  return res;
}

describe("mediaIdsInAttach", () => {
  it("a bare id, or our media URLs", () => {
    expect(mediaIdsInAttach("ckabc12345")).toEqual(["ckabc12345"]);
    expect(mediaIdsInAttach("https://h/api/media/ckabc12345/public?token=x")).toEqual(["ckabc12345"]);
    expect(mediaIdsInAttach("/api/media/ckabc12345/file")).toEqual(["ckabc12345"]);
    expect(mediaIdsInAttach("https://cdn.example.com/pic.jpg")).toEqual([]);
    expect(mediaIdsInAttach(null)).toEqual([]);
  });
});

describe("attachment route 404 for foreign workspace", () => {
  it("workspace B's ticket id, or a valid ticket with B's attachment id, from A -> 404 tickets.attachment_not_found, no storage read", async () => {
    const { prisma, svc, storageCalls } = world();
    prisma.db.ticketAttachment.push({ id: "att-b", workspaceId: B, ticketId: "tB", mediaId: "md-b", source: "customer", createdAt: new Date() });
    for (const [ticketId, attId] of [
      ["tB", "att-b"], // B's ticket and attachment
      ["tA", "att-b"], // A's ticket, B's attachment
      ["missing", "att-b"],
      ["tA", "missing"],
    ]) {
      const e = await errOf(svc.serve(A, ticketId, attId, fakeRes(), owner));
      expect(e).toBeInstanceOf(NotFoundException);
      expect(e.getResponse()).toEqual({ statusCode: 404, message: "tickets.attachment_not_found" });
      const u = await errOf(svc.unlink(A, ticketId, attId, owner));
      expect(u.getResponse()).toMatchObject({ message: "tickets.attachment_not_found" });
    }
    // Listing or attaching on B's ticket from A is a 404 too.
    await expect(svc.list(A, "tB", owner)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.candidates(A, "tB", owner)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.attach(A, "tB", "md-b", owner)).rejects.toBeInstanceOf(NotFoundException);
    expect(storageCalls).toEqual([]);
    expect(prisma.db.ticketAttachment.map((a: any) => a.id)).toEqual(["att-b"]);
  });

  it("attachment id of another ticket is 404 (same workspace)", async () => {
    const { prisma, svc, storageCalls } = world();
    prisma.db.ticketAttachment.push({ id: "att-2", workspaceId: A, ticketId: "tA2", mediaId: "md-staff", source: "staff", createdAt: new Date() });
    const e = await errOf(svc.serve(A, "tA", "att-2", fakeRes(), owner));
    expect(e.getResponse()).toEqual({ statusCode: 404, message: "tickets.attachment_not_found" });
    await expect(svc.unlink(A, "tA", "att-2", owner)).rejects.toBeInstanceOf(NotFoundException);
    expect(storageCalls).toEqual([]);
    expect(prisma.db.ticketAttachment).toHaveLength(1);
  });
});

describe("customer attachment must come from the ticket conversation", () => {
  it("an inbound file of the ticket's conversation is linked as customer with its message", async () => {
    const { svc, prisma } = world();
    const dto = await svc.attach(A, "tA", "md-cust", owner, OWNER);
    expect(dto).toMatchObject({
      ticketId: "tA",
      mediaId: "md-cust",
      source: "customer",
      messageId: "m-in",
      fileName: "md-cust.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 1234,
      addedBy: { id: OWNER, name: "Owner" },
      url: `/api/tickets/tA/attachments/${dto.id}`,
    });
    expect(JSON.stringify(dto)).not.toContain("secret-key");
    expect(prisma.db.ticketAttachment).toHaveLength(1);
    // Our public-link form of an inbound attach works too.
    await expect(svc.attach(A, "tA", "md-url0001", owner)).resolves.toMatchObject({ messageId: "m-in-url" });
  });

  it("outbound, another conversation, another workspace, a staff upload or an unknown id -> 404 attachment_source_not_found", async () => {
    const { svc, prisma } = world();
    for (const id of ["md-out", "md-other", "md-b", "md-staff", "nope"]) {
      const e = await errOf(svc.attach(A, "tA", id, owner));
      expect({ id, status: e.getStatus(), body: e.getResponse() }).toEqual({
        id,
        status: 404,
        body: { statusCode: 404, message: "tickets.attachment_source_not_found" },
      });
    }
    expect(prisma.db.ticketAttachment).toHaveLength(0);
  });

  it("a ticket without a conversation -> 400 tickets.no_conversation", async () => {
    const { svc } = world();
    const e = await errOf(svc.attach(A, "tA2", "md-cust", owner));
    expect(e.getResponse()).toEqual({ statusCode: 400, message: "tickets.no_conversation" });
  });

  it("the same media twice -> 409 attachment_exists; the 51st -> 400 attachments_full", async () => {
    const { svc, prisma } = world();
    await svc.attach(A, "tA", "md-cust", owner);
    const dup = await errOf(svc.attach(A, "tA", "md-cust", owner));
    expect(dup.getStatus()).toBe(409);
    expect(dup.getResponse()).toMatchObject({ message: "tickets.attachment_exists" });

    for (let i = prisma.db.ticketAttachment.length; i < TICKET_ATTACHMENTS_MAX; i++) {
      prisma.db.ticketAttachment.push({ id: `fill-${i}`, workspaceId: A, ticketId: "tA", mediaId: `fill-m-${i}`, source: "staff", createdAt: new Date() });
    }
    const full = await errOf(svc.attach(A, "tA", "md-url0001", owner));
    expect(full.getResponse()).toEqual({ statusCode: 400, message: "tickets.attachments_full", limit: 50 });
    expect(prisma.db.ticketAttachment).toHaveLength(TICKET_ATTACHMENTS_MAX);
  });

  it("candidates: inbound files of the conversation not yet attached, newest first; [] without a conversation", async () => {
    const { svc } = world();
    const before = await svc.candidates(A, "tA", owner);
    expect(before.items.map((c) => c.mediaId)).toEqual(["md-url0001", "md-cust"]);
    expect(before.items[1]).toEqual({
      mediaId: "md-cust",
      messageId: "m-in",
      fileName: "md-cust.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 1234,
      at: new Date(Date.UTC(2026, 10, 15, 10, 1)),
    });
    await svc.attach(A, "tA", "md-cust", owner);
    expect((await svc.candidates(A, "tA", owner)).items.map((c) => c.mediaId)).toEqual(["md-url0001"]);
    expect(await svc.candidates(A, "tA2", owner)).toEqual({ items: [] });
  });
});

describe("staff upload links a sniffed library file", () => {
  it("a real PNG -> a Media row with uploadedById and a staff link; the temp file is removed", async () => {
    const { svc, prisma } = world();
    const p = await staged(PNG);
    const dto = await svc.upload(A, "tA2", upload({ path: p }), OWNER);
    const row = prisma.db.media.find((m: any) => m.id === dto.mediaId);
    expect(row).toMatchObject({ workspaceId: A, uploadedById: OWNER, mimeType: "image/png" });
    expect(dto).toMatchObject({ ticketId: "tA2", source: "staff", messageId: null, addedBy: { id: OWNER, name: "Owner" } });
    await expect(fsp.access(p)).rejects.toBeTruthy();
  });

  it("a PNG-declared HTML file -> 400 media.type_mismatch, nothing linked or stored", async () => {
    const { svc, prisma, storage } = world();
    const p = await staged(HTML);
    const e = await errOf(svc.upload(A, "tA", upload({ path: p, size: HTML.length }), OWNER));
    expect(e.getResponse()).toMatchObject({ statusCode: 400, message: "media.type_mismatch" });
    expect(prisma.db.ticketAttachment).toHaveLength(0);
    expect(storage.put).not.toHaveBeenCalled();
    await expect(fsp.access(p)).rejects.toBeTruthy();
  });

  it("a foreign ticket -> 404 before the upload runs (temp file removed)", async () => {
    const { svc, storage } = world();
    const p = await staged(PNG);
    await expect(svc.upload(A, "tB", upload({ path: p }), OWNER)).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.put).not.toHaveBeenCalled();
    await expect(fsp.access(p)).rejects.toBeTruthy();
  });
});

describe("download streams bytes and never exposes a storage url", () => {
  const spies: jest.SpyInstance[] = [];
  const logged = () => JSON.stringify(spies.flatMap((s) => s.mock.calls));
  beforeEach(() => {
    for (const m of ["log", "warn", "error", "debug", "verbose"] as const) {
      spies.push(jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined));
      spies.push(jest.spyOn(Logger, m).mockImplementation(() => undefined));
    }
  });
  afterEach(() => {
    spies.splice(0).forEach((s) => s.mockRestore());
  });

  it("local storage: the file is sent with the SP-13 serve headers and a 5-minute private cache", async () => {
    const { svc, prisma, storage } = world();
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ticket-dl-"));
    const file = path.join(dir, "f.pdf");
    await fsp.writeFile(file, Buffer.from("%PDF-1.7 bytes"));
    storage.resolveAbsolute.mockImplementation(() => file);
    prisma.db.media.push(media("md-pdf", A, { mimeType: "application/pdf", fileName: "تقرير report.pdf", uploadedById: OWNER }));
    prisma.db.ticketAttachment.push({ id: "att-pdf", workspaceId: A, ticketId: "tA", mediaId: "md-pdf", source: "staff", createdAt: new Date() });

    const res = fakeRes();
    let body = Buffer.alloc(0);
    res.sendFile.mockImplementation(async (p: string) => (body = await fsp.readFile(p)));
    await svc.serve(A, "tA", "att-pdf", res, owner);
    await res.sendFile.mock.results[0].value;
    expect(body.toString()).toBe("%PDF-1.7 bytes");
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBe("sandbox");
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="[^"]*"; filename\*=UTF-8''/);
    expect(res.headers["cache-control"]).toBe("private, max-age=300");
    expect(JSON.stringify(res.headers)).not.toContain("secret-key");
    expect(logged()).not.toContain("secret-key");
  });

  it("Spaces: the signed object is proxied as a stream, never a redirect, and the URL never leaves the server", async () => {
    const { svc, prisma } = world();
    prisma.db.media.push(media("md-sp", A, { storageKind: "spaces", mimeType: "image/png", uploadedById: OWNER }));
    prisma.db.ticketAttachment.push({ id: "att-sp", workspaceId: A, ticketId: "tA", mediaId: "md-sp", source: "staff", createdAt: new Date() });
    const realFetch = global.fetch;
    const fetched: string[] = [];
    global.fetch = jest.fn(async (u: any) => {
      fetched.push(String(u));
      return new Response(new Uint8Array(PNG), { status: 200, headers: { "content-length": String(PNG.length) } });
    }) as never;
    try {
      const out = new PassThrough();
      const chunks: Buffer[] = [];
      out.on("data", (c) => chunks.push(c));
      const res: any = Object.assign(out, {
        headers: {} as Record<string, string>,
        setHeader(k: string, v: string) {
          res.headers[k.toLowerCase()] = v;
        },
        redirect: jest.fn(),
      });
      await svc.serve(A, "tA", "att-sp", res, owner);
      expect(Buffer.concat(chunks)).toEqual(PNG);
      expect(res.redirect).not.toHaveBeenCalled();
      expect(fetched).toEqual([expect.stringContaining("X-Amz-Signature")]);
      expect(res.headers).toMatchObject({ "content-type": "image/png", "cache-control": "private, max-age=300", "content-length": String(PNG.length) });
      const visible = JSON.stringify(res.headers) + logged();
      expect(visible).not.toContain("X-Amz-Signature");
      expect(visible).not.toContain("bucket.example");
      expect(visible).not.toContain("secret-key");
    } finally {
      global.fetch = realFetch;
    }
  });

  it("a failed upstream is a 404 whose message carries no URL", async () => {
    const { svc, prisma } = world();
    prisma.db.media.push(media("md-sp", A, { storageKind: "spaces", uploadedById: OWNER }));
    prisma.db.ticketAttachment.push({ id: "att-sp", workspaceId: A, ticketId: "tA", mediaId: "md-sp", source: "staff", createdAt: new Date() });
    const realFetch = global.fetch;
    global.fetch = jest.fn(async () => new Response(null, { status: 403 })) as never;
    try {
      const e = await errOf(svc.serve(A, "tA", "att-sp", fakeRes(), owner));
      expect(e).toBeInstanceOf(NotFoundException);
      expect(JSON.stringify(e.getResponse())).not.toMatch(/bucket|Signature|secret-key/);
    } finally {
      global.fetch = realFetch;
    }
  });
});

describe("unlink and media delete", () => {
  it("unlink keeps the library file; a second unlink is 404", async () => {
    const { svc, prisma, storage } = world();
    const dto = await svc.attach(A, "tA", "md-cust", owner);
    await expect(svc.unlink(A, "tA", dto.id, owner)).resolves.toEqual({ ok: true });
    expect(prisma.db.ticketAttachment).toHaveLength(0);
    expect(prisma.db.media.some((m: any) => m.id === "md-cust")).toBe(true);
    expect(storage.delete).not.toHaveBeenCalled();
    const again = await errOf(svc.unlink(A, "tA", dto.id, owner));
    expect(again.getResponse()).toMatchObject({ message: "tickets.attachment_not_found" });
  });

  it("attach and media delete serialize", async () => {
    // Both take the same advisory lock (media:<id>), so one of two orders happens.
    // Delete first: the attach finds the file gone -> 404.
    {
      const { svc, mediaSvc, prisma } = world();
      await mediaSvc.remove(A, "md-cust");
      const e = await errOf(svc.attach(A, "tA", "md-cust", owner));
      expect(e.getStatus()).toBe(404);
      expect(prisma.db.ticketAttachment).toHaveLength(0);
    }
    // Attach first: the delete sees the link -> 409 media.in_use listing the ticket; nothing removed.
    {
      const { svc, mediaSvc, prisma, storage } = world();
      await svc.attach(A, "tA", "md-cust", owner);
      const e = await errOf(mediaSvc.remove(A, "md-cust"));
      expect(e.getStatus()).toBe(409);
      expect(e.getResponse()).toEqual({
        statusCode: 409,
        message: "media.in_use",
        templates: [],
        campaigns: [],
        tickets: [{ id: "tA", number: 7, pipelineId: "pl" }],
        knowledge: [],
      });
      expect(prisma.db.media.some((m: any) => m.id === "md-cust")).toBe(true);
      expect(storage.delete).not.toHaveBeenCalled();
      const locks = prisma.$executeRaw.mock.calls.map((c: any[]) => `${c[0].join("?")}|${c.slice(1).join(",")}`);
      expect(locks.filter((l: string) => l.includes("pg_advisory_xact_lock") && l.endsWith("|media:md-cust"))).toHaveLength(2);
    }
  });

  it("a FK cascade (deployed main deleting the file) drops the link", async () => {
    const { svc, prisma } = world();
    await svc.attach(A, "tA", "md-cust", owner);
    await prisma.media.delete({ where: { id: "md-cust" } });
    expect(prisma.db.ticketAttachment).toHaveLength(0);
  });
});

/**
 * A lock-honouring $transaction for the double: pg_advisory_xact_lock keys are
 * held until the callback settles, so concurrent callers queue like Postgres.
 */
function withAdvisoryLocks(prisma: any) {
  const held = new Map<string, Promise<void>>();
  const base = prisma.$executeRaw;
  prisma.$transaction = jest.fn(async (cb: any) => {
    const releases: Array<() => void> = [];
    const tx = Object.create(prisma);
    tx.$executeRaw = async (strings: TemplateStringsArray, ...vals: any[]) => {
      const sql = strings.join("?");
      if (/pg_advisory_xact_lock/.test(sql)) {
        const key = String(vals[0]);
        while (held.has(key)) await held.get(key);
        let release!: () => void;
        held.set(key, new Promise<void>((r) => (release = r)));
        releases.push(() => {
          held.delete(key);
          release();
        });
      }
      return base(strings, ...vals);
    };
    try {
      return await cb(tx);
    } finally {
      releases.forEach((r) => r());
    }
  });
}

describe("attachment cap under concurrent links (M2)", () => {
  it("two links of different files at 49 -> exactly one wins, the other is 400 attachments_full", async () => {
    const { svc, prisma } = world();
    withAdvisoryLocks(prisma);
    for (let i = 0; i < TICKET_ATTACHMENTS_MAX - 1; i++) {
      prisma.db.ticketAttachment.push({ id: `fill-${i}`, workspaceId: A, ticketId: "tA", mediaId: `fill-m-${i}`, source: "staff", createdAt: new Date() });
    }
    const results = await Promise.allSettled([
      svc.attach(A, "tA", "md-cust", owner),
      svc.attach(A, "tA", "md-url0001", owner),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason.getResponse()).toEqual({ statusCode: 400, message: "tickets.attachments_full", limit: 50 });
    expect(prisma.db.ticketAttachment.filter((a: any) => a.ticketId === "tA")).toHaveLength(TICKET_ATTACHMENTS_MAX);
  });

  it("the link takes the ticket lock (ticket-att:<id>) before counting, plus the media lock", async () => {
    const { svc, prisma } = world();
    await svc.attach(A, "tA", "md-cust", owner);
    const locks = prisma.$executeRaw.mock.calls
      .filter((c: any[]) => c[0].join("?").includes("pg_advisory_xact_lock"))
      .map((c: any[]) => c[1]);
    expect(locks).toEqual(expect.arrayContaining(["media:md-cust", "ticket-att:tA"]));
  });

  it("the link transaction allows waiting on the ticket lock beyond Prisma's 5 s default (live F1)", async () => {
    const { svc, prisma } = world();
    const spy = jest.spyOn(prisma, "$transaction");
    await svc.attach(A, "tA", "md-cust", owner);
    const call = spy.mock.calls.find((c: any[]) => typeof c[0] === "function");
    expect(call?.[1]).toEqual(TICKET_ATTACHMENT_TX_OPTIONS);
    expect(TICKET_ATTACHMENT_TX_OPTIONS.timeout).toBeGreaterThanOrEqual(30_000);
  });
});

describe("attachmentCount uses the same visibility rule as the list (M3)", () => {
  it("a deleted conversation: an unrestricted viewer sees and counts the customer file; an assigned-only agent neither", async () => {
    const { svc, prisma, perm } = world();
    const { TicketsService } = await import("./tickets.service");
    const tickets = new TicketsService(prisma, { emitToWorkspace: jest.fn() } as never, undefined, undefined, perm);
    await svc.attach(A, "tA", "md-cust", owner);
    prisma.db.ticketAttachment.push({ id: "att-s", workspaceId: A, ticketId: "tA", mediaId: "md-staff", source: "staff", createdAt: new Date() });
    // The conversation row is deleted; Ticket.conversationId has no FK, so it dangles.
    prisma.db.conversation = prisma.db.conversation.filter((c: any) => c.id !== "cA");

    for (const [viewer, n] of [
      [owner, 2],
      [{ userId: "x", bypass: true }, 2],
      [{ userId: "me" }, 1],
    ] as const) {
      const listed = (await svc.list(A, "tA", viewer)).items.length;
      const t: any = await tickets.getTicket(A, "tA", viewer);
      expect({ viewer: viewer.userId, listed, count: t.attachmentCount, channel: t.channel }).toEqual({
        viewer: viewer.userId,
        listed: n,
        count: n,
        channel: null,
      });
    }
  });
});
