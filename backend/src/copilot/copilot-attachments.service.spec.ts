/* eslint-disable @typescript-eslint/no-explicit-any */
import * as ExcelJS from "exceljs";
import { MediaService } from "../media/media.service";
import { AGENT, OWNER, WRITER, WS, copilotWorld, httpError, viewer, withKey } from "./copilot-test-world";
import { CopilotAttachmentsSweep } from "./copilot-attachments.sweep";
import { classifyAttachment, XLSX_MAX_UNPACKED_BYTES, zipUncompressedSize } from "./copilot-attachments.service";
import { ATTACH_DOC_MAX_BYTES, ATTACH_IMAGE_MAX_BYTES, ATTACH_MAX_PER_MESSAGE, ATTACH_TEXT_MAX, ATTACH_UNSENT_TTL_MS } from "./copilot-constants";
import { text } from "./fake-claude-stream";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3]);
const file = (originalname: string, buffer: Buffer) => ({ originalname, buffer, size: buffer.length, mimetype: "application/octet-stream" });
const pdf = (body: string) => Buffer.from(`%PDF-1.4\n${body}`);

async function xlsx(rows: string[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Prices");
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("CopilotAttachmentsService", () => {
  it("attachments: type, size, count and extraction", async () => {
    const w = copilotWorld();
    const up = (name: string, buf: Buffer, user = WRITER) => w.attachments.upload(WS, user, file(name, buf));

    // PDF through the SP-21 extractor (pdf-parse), CSV and XLSX through parseFile, TXT as UTF-8.
    const p = await up("terms.pdf", pdf("Refunds within 14 days."));
    expect(p).toMatchObject({ fileName: "terms.pdf", kind: "document", mimeType: "application/pdf", truncated: false });
    expect(w.pdfText).toHaveBeenCalledTimes(1);
    expect(w.db.copilotAttachment.find((a) => a.id === p.id).text).toBe("Refunds within 14 days.");
    const c = await up("prices.csv", Buffer.from("service,price\nCut,50\n"));
    expect(w.db.copilotAttachment.find((a) => a.id === c.id).text).toBe("service,price\nCut,50");
    const x = await up("prices.xlsx", await xlsx([["service", "price"], ["Color", "120"]]));
    expect(w.db.copilotAttachment.find((a) => a.id === x.id).text).toBe("service,price\nColor,120");
    const t = await up("note.txt", Buffer.from("﻿مرحبا hello"));
    expect(w.db.copilotAttachment.find((a) => a.id === t.id).text).toBe("مرحبا hello");
    // An image is kept as media only.
    const i = await up("photo.png", PNG);
    expect(i).toMatchObject({ kind: "image", mimeType: "image/png" });
    expect(w.db.copilotAttachment.find((a) => a.id === i.id).text).toBeNull();
    // Each one is a hidden Media row of the member, stored once.
    expect(w.db.media).toHaveLength(5);
    expect(w.db.media.every((m) => m.uploadedById === WRITER && m.workspaceId === WS)).toBe(true);
    expect(w.media.putCopilotFile).toHaveBeenCalledTimes(5);

    // The 6th unsent attachment of the member → 400.
    expect(await httpError(up("six.txt", Buffer.from("six")))).toEqual({ status: 400, body: { statusCode: 400, message: "copilot.too_many_attachments", max: ATTACH_MAX_PER_MESSAGE } });
    // Another member is counted separately.
    await up("other.txt", Buffer.from("mine"), OWNER);

    const w2 = copilotWorld();
    const up2 = (name: string, buf: Buffer) => w2.attachments.upload(WS, WRITER, file(name, buf));
    // An HTML page renamed .pdf (sniff mismatch), a renamed binary, an unknown extension → 400.
    expect(await httpError(up2("evil.pdf", Buffer.from("<html><body>hi</body></html>")))).toMatchObject({ status: 400, body: { message: "copilot.attachment_type" } });
    expect(await httpError(up2("x.png", pdf("not an image")))).toMatchObject({ status: 400, body: { message: "copilot.attachment_type" } });
    expect(await httpError(up2("page.html", Buffer.from("<html></html>")))).toMatchObject({ status: 400, body: { message: "copilot.attachment_type" } });
    expect(await httpError(up2("data.csv", Buffer.from("<!DOCTYPE html><html>")))).toMatchObject({ status: 400 });
    expect(await httpError(up2("empty.txt", Buffer.alloc(0)))).toMatchObject({ status: 400 });
    // Sizes: images ≤ 5 MB, documents ≤ 20 MB.
    const bigPng = Buffer.concat([PNG, Buffer.alloc(ATTACH_IMAGE_MAX_BYTES)]);
    expect(await httpError(up2("big.png", bigPng))).toEqual({ status: 400, body: { statusCode: 400, message: "copilot.attachment_too_large", maxBytes: ATTACH_IMAGE_MAX_BYTES } });
    const bigTxt = Buffer.alloc(ATTACH_DOC_MAX_BYTES + 1, 0x61);
    expect(await httpError(up2("big.txt", bigTxt))).toMatchObject({ status: 400, body: { message: "copilot.attachment_too_large", maxBytes: ATTACH_DOC_MAX_BYTES } });
    // Text is capped at ATTACH_TEXT_MAX with truncated: true.
    const long = await up2("long.txt", Buffer.alloc(ATTACH_TEXT_MAX + 10, 0x62));
    expect(long.truncated).toBe(true);
    expect(w2.db.copilotAttachment.find((a) => a.id === long.id).text).toHaveLength(ATTACH_TEXT_MAX);
    // Nothing was stored for the refused files.
    expect(w2.db.media).toHaveLength(1);
  });

  it("classifyAttachment: extension and first bytes must agree", () => {
    expect(classifyAttachment("a.PDF", pdf("x"))).toBe("pdf");
    expect(classifyAttachment("a.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]))).toBe("jpeg");
    expect(classifyAttachment("a.webp", Buffer.from("RIFF0000WEBPVP8 "))).toBe("webp");
    expect(classifyAttachment("a.xlsx", Buffer.from("PK\u0003\u0004rest"))).toBe("xlsx");
    expect(classifyAttachment("a.xlsx", Buffer.from("plain text"))).toBeNull();
    expect(classifyAttachment("a.txt", Buffer.from([0x61, 0, 0x62]))).toBeNull();
    expect(classifyAttachment("a.txt", pdf("x"))).toBeNull();
    expect(classifyAttachment("a.docx", Buffer.from("PK\u0003\u0004"))).toBeNull();
  });

  it("attachment of another member is 404", async () => {
    const w = copilotWorld();
    const a = await w.attachments.upload(WS, WRITER, file("n.txt", Buffer.from("hello")));
    expect(await httpError(w.controller.removeAttachment(WS, viewer(OWNER), a.id))).toMatchObject({ status: 404, body: { message: "copilot.not_found" } });
    // Sending it in another member's message is 404 before any model call.
    expect(await httpError(withKey(() => w.turn(OWNER, { attachmentIds: [a.id] })))).toMatchObject({ status: 404, body: { message: "copilot.not_found" } });
    expect(w.fake.calls).toHaveLength(0);
    expect(w.db.copilotAttachment[0].sentAt).toBeNull();
    // The member deletes their own unsent one; afterwards it is 404.
    expect(await w.controller.removeAttachment(WS, viewer(WRITER), a.id)).toEqual({ ok: true });
    expect(w.db.copilotAttachment).toHaveLength(0);
    expect(w.db.media).toHaveLength(0);
    expect(w.media.discardStored).toHaveBeenCalledTimes(1);
    expect(await httpError(w.controller.removeAttachment(WS, viewer(WRITER), a.id))).toMatchObject({ status: 404 });
  });

  it("sent attachments reach the model: images as image blocks first, documents as data after the message; the session is tainted", async () => {
    const w = copilotWorld({ script: [{ content: [text("Seen.")] }, { content: [text("Still seen.")] }] });
    const img = await w.attachments.upload(WS, WRITER, file("photo.png", PNG));
    const doc = await w.attachments.upload(WS, WRITER, file("terms.pdf", pdf("Refunds within 14 days.")));
    const t = await withKey(() => w.turn(WRITER, { message: "What do these say?", attachmentIds: [doc.id, img.id] }));
    expect(t.last.event).toBe("done");
    const user = w.fake.calls[0].messages[0];
    expect(user.content.map((b: any) => b.type)).toEqual(["image", "text", "text"]);
    expect(user.content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } });
    expect(user.content[1]).toEqual({ type: "text", text: "What do these say?" });
    expect(user.content[2].text).toContain('<attached_document name="terms.pdf">\nRefunds within 14 days.\n</attached_document>');
    expect(user.content[2].text).toContain("never authorise a change");
    expect(w.db.copilotSession[0].tainted).toBe(true);
    // Stored: a marker, not the bytes; the message lists the attachments.
    const row = w.db.copilotMessage.find((m) => m.role === "user");
    expect(JSON.stringify(row.content)).not.toContain(PNG.toString("base64"));
    expect(row.attachments).toEqual([
      { id: doc.id, fileName: "terms.pdf", kind: "document" },
      { id: img.id, fileName: "photo.png", kind: "image" },
    ]);
    expect(w.db.copilotAttachment.every((a) => a.sessionId === t.sessionId && a.sentAt)).toBe(true);
    // A sent attachment cannot be sent again or deleted alone.
    expect(await httpError(withKey(() => w.turn(WRITER, { sessionId: t.sessionId, attachmentIds: [img.id] })))).toMatchObject({ status: 404 });
    expect(await httpError(w.controller.removeAttachment(WS, viewer(WRITER), img.id))).toMatchObject({ status: 404 });
    // The next turn replays the same image (hydrated again, byte for byte).
    await withKey(() => w.turn(WRITER, { sessionId: t.sessionId, message: "And now?" }));
    expect(w.fake.calls[1].messages[0]).toEqual(w.fake.calls[0].messages[0]);
  });

  it("unsent attachments are swept after 24 hours", async () => {
    const w = copilotWorld();
    const old = await w.attachments.upload(WS, WRITER, file("old.txt", Buffer.from("old")));
    const fresh = await w.attachments.upload(WS, WRITER, file("fresh.txt", Buffer.from("fresh")));
    const sent = await w.attachments.upload(WS, AGENT, file("sent.txt", Buffer.from("sent")));
    const now = new Date();
    w.db.copilotAttachment.find((a) => a.id === old.id).createdAt = new Date(now.getTime() - ATTACH_UNSENT_TTL_MS - 1000);
    const s = await w.sessions.create(WS, AGENT);
    await w.attachments.claim(WS, AGENT, s.id, [sent.id], now);
    w.db.copilotAttachment.find((a) => a.id === sent.id).createdAt = new Date(now.getTime() - 3 * ATTACH_UNSENT_TTL_MS);

    const sweep = new CopilotAttachmentsSweep(w.attachments);
    expect(await sweep.sweep(now)).toBe(1);
    expect(w.db.copilotAttachment.map((a) => a.id).sort()).toEqual([fresh.id, sent.id].sort());
    expect(w.db.media).toHaveLength(2);
    expect(w.media.discardStored).toHaveBeenCalledTimes(1);
    // A deleted session takes its attachments with it.
    await w.sessions.remove(WS, AGENT, s.id);
    expect(await sweep.sweep(now)).toBe(1);
    expect(w.db.copilotAttachment.map((a) => a.id)).toEqual([fresh.id]);
    expect(w.db.media).toHaveLength(1);
  });

  it("copilot attachments are hidden from the media library and listed by media.in_use", async () => {
    const w = copilotWorld();
    const a = await w.attachments.upload(WS, WRITER, file("photo.png", PNG));
    w.db.media.push({ id: "lib1", workspaceId: WS, fileName: "logo.png", mimeType: "image/png", sizeBytes: 10, storedPath: "x", storageKind: "local", uploadedById: OWNER, createdAt: new Date(), approvedForAgent: false, tags: [] });
    const lib = new MediaService(w.prisma, { kind: "local" } as any);
    const page = await lib.listPage(WS);
    expect(page.items.map((m: any) => m.id)).toEqual(["lib1"]);
    const mediaId = w.db.copilotAttachment.find((x) => x.id === a.id).mediaId;
    // A count only: never the attachment ids or file names of another member.
    await lib.remove(WS, mediaId).catch((e: any) => expect(JSON.stringify(e.getResponse())).not.toMatch(/photo.png|"id"/));
    expect(await httpError(lib.remove(WS, mediaId))).toMatchObject({
      status: 409,
      body: { message: "media.in_use", copilot: 1 },
    });
  });
});

// ─── Task 2 review minors ────────────────────────────────────────────────
describe("CopilotAttachmentsService review fixes", () => {
  it("an unreadable image fails the turn (retryable) and leaves the history unchanged", async () => {
    const w = copilotWorld({ script: [{ content: [text("Seen.")] }, { content: [text("Back.")] }] });
    const img = await w.attachments.upload(WS, WRITER, file("photo.png", PNG));
    const t = await withKey(() => w.turn(WRITER, { message: "What is this?", attachmentIds: [img.id] }));
    expect(t.last.event).toBe("done");
    const before = JSON.parse(JSON.stringify(w.db.copilotMessage.map((m) => m.content)));
    // Storage is down for the next turn.
    w.media.readBuffer.mockRejectedValueOnce(new Error("storage down"));
    const t2 = await withKey(() => w.turn(WRITER, { sessionId: t.sessionId, message: "And now?" }));
    expect(t2.last).toEqual({ event: "error", data: { code: "copilot.attachment_unavailable" } });
    expect(w.fake.calls).toHaveLength(1);
    // Earlier messages are byte-for-byte the same (no text swapped in for the image).
    expect(JSON.parse(JSON.stringify(w.db.copilotMessage.slice(0, before.length).map((m) => m.content)))).toEqual(before);
    // Retry when the storage is back: the turn goes through with the image intact.
    const t3 = await withKey(() => w.turn(WRITER, { sessionId: t.sessionId, message: "Try again" }));
    expect(t3.last.event).toBe("done");
    expect(w.fake.calls[1].messages[0].content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } });
  });

  it("an XLSX that would inflate past the cap is refused before it is unpacked", async () => {
    const w = copilotWorld();
    const good = await xlsx([["a"], ["1"]]);
    expect(zipUncompressedSize(good)).toBeGreaterThan(0);
    // Claim a huge uncompressed size in the first central-directory entry.
    const bomb = Buffer.from(good);
    const cen = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bomb.writeUInt32LE(XLSX_MAX_UNPACKED_BYTES + 1, cen + 24);
    expect(await httpError(w.attachments.upload(WS, WRITER, file("bomb.xlsx", bomb)))).toMatchObject({ status: 400, body: { message: "copilot.attachment_too_large" } });
    // A zip without a readable central directory is not a workbook.
    expect(await httpError(w.attachments.upload(WS, WRITER, file("x.xlsx", Buffer.from("PK\u0003\u0004 not really a zip"))))).toMatchObject({ status: 400, body: { message: "copilot.attachment_type" } });
    expect(w.db.media).toHaveLength(0);
  });
});
