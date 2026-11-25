import { Readable } from "node:stream";
import { lastValueFrom, of } from "rxjs";
import { decodeFileName, KnowledgeUploadInterceptor } from "./knowledge-upload.interceptor";
import { KB_BATCH_MAX, KB_FILE_MAX_BYTES } from "./knowledge-constants";

const BOUNDARY = "----kbspecboundary";

/** A multipart body; file names are written as raw UTF-8 bytes, as browsers send them. */
function multipart(parts: { field?: string; name: string; bytes: Buffer }[]): Buffer {
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${p.field ?? "files"}"; filename="${p.name}"\r\nContent-Type: application/pdf\r\n\r\n`,
        "utf8",
      ),
    );
    chunks.push(p.bytes, Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
}

/** Run the interceptor (real multer) over a request stream. */
async function through(body: Buffer) {
  const req = Object.assign(Readable.from([body]), {
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}`, "content-length": String(body.length) },
    method: "POST",
    url: "/knowledge/files",
  }) as unknown as { files?: Express.Multer.File[] };
  const ctx = { switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }) } as never;
  const next = { handle: jest.fn(() => of("handled")) };
  try {
    const out = await lastValueFrom(await new KnowledgeUploadInterceptor().intercept(ctx, next));
    return { ok: true as const, out, files: req.files ?? [], next };
  } catch (e: any) {
    return { ok: false as const, status: e.getStatus?.(), body: e.getResponse?.(), next };
  }
}

const PDF = Buffer.from("%PDF-1.7\nsmall", "latin1");

describe("knowledge upload interceptor", () => {
  it("parses files through multer and keeps Arabic file names in UTF-8", async () => {
    const r = await through(multipart([{ name: "قائمة الأسعار.pdf", bytes: PDF }, { name: "menu.pdf", bytes: PDF }]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.out).toBe("handled");
    expect(r.files.map((f) => f.originalname)).toEqual(["قائمة الأسعار.pdf", "menu.pdf"]);
    expect(r.files[0].buffer.equals(PDF)).toBe(true);
    // The decoder: a latin1 mis-decoding becomes UTF-8; real names stay as they are.
    expect(decodeFileName(Buffer.from("قائمة.pdf", "utf8").toString("latin1"))).toBe("قائمة.pdf");
    expect(decodeFileName("قائمة.pdf")).toBe("قائمة.pdf");
    expect(decodeFileName("café.pdf")).toBe("café.pdf"); // a real latin1 name is not valid UTF-8 bytes
    expect(decodeFileName("menu.pdf")).toBe("menu.pdf");
  });

  it("maps multer limits to knowledge keys", async () => {
    const big = await through(multipart([{ name: "huge.pdf", bytes: Buffer.alloc(KB_FILE_MAX_BYTES + 1, 0x20) }]));
    expect(big).toMatchObject({ ok: false, status: 413, body: { statusCode: 413, message: "knowledge.file_too_large", maxBytes: KB_FILE_MAX_BYTES } });

    const many = await through(multipart(Array.from({ length: KB_BATCH_MAX + 1 }, (_, i) => ({ name: `f${i}.pdf`, bytes: PDF }))));
    expect(many).toMatchObject({ ok: false, status: 400, body: { statusCode: 400, message: "knowledge.batch_too_large", max: KB_BATCH_MAX } });

    const wrongField = await through(multipart([{ field: "file", name: "a.pdf", bytes: PDF }]));
    expect(wrongField).toMatchObject({ ok: false, status: 400, body: { message: "knowledge.batch_too_large" } });

    const broken = await through(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="files"; filename="a.pdf"\r\n\r\nno end`));
    expect(broken).toMatchObject({ ok: false, status: 400, body: { message: "knowledge.file_type" } });
    for (const r of [big, many, wrongField, broken]) expect(r.next.handle).not.toHaveBeenCalled();
  });
});
