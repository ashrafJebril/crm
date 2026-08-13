import { BadRequestException } from "@nestjs/common";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MediaService } from "./media.service";

function makeFile(over: Partial<Express.Multer.File>): Express.Multer.File {
  return {
    fieldname: "file",
    originalname: "clip.mp4",
    encoding: "7bit",
    mimetype: "video/mp4",
    size: 5 * 1024 * 1024,
    buffer: Buffer.alloc(0),
    path: "C:/tmp/fake-upload",
    destination: "",
    filename: "",
    stream: undefined as never,
    ...over,
  } as Express.Multer.File;
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
    const row = await svc.finalizeUpload("ws1", makeFile({}), "u1");
    expect(storage.put).toHaveBeenCalledWith(
      expect.objectContaining({ sourcePath: "C:/tmp/fake-upload", mimeType: "video/mp4" }),
    );
    expect(row.mimeType).toBe("video/mp4");
  });

  it("accepts video/quicktime", async () => {
    await expect(
      svc.finalizeUpload("ws1", makeFile({ mimetype: "video/quicktime", originalname: "clip.mov" }), "u1"),
    ).resolves.toBeTruthy();
  });

  it("rejects a video over 300MB", async () => {
    await expect(
      svc.finalizeUpload("ws1", makeFile({ size: 301 * 1024 * 1024 }), "u1"),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects unsupported video types", async () => {
    await expect(
      svc.finalizeUpload("ws1", makeFile({ mimetype: "video/x-msvideo" }), "u1"),
    ).rejects.toThrow(BadRequestException);
  });

  it("still enforces the 20MB image cap (25MB png rejected)", async () => {
    await expect(
      svc.finalizeUpload("ws1", makeFile({ mimetype: "image/png", originalname: "big.png", size: 25 * 1024 * 1024 }), "u1"),
    ).rejects.toThrow(BadRequestException);
  });

  it("still accepts a normal image (uses sourcePath when present)", async () => {
    const row = await svc.finalizeUpload(
      "ws1",
      makeFile({ mimetype: "image/jpeg", originalname: "a.jpg", size: 2 * 1024 * 1024 }),
      "u1",
    );
    expect(row.mimeType).toBe("image/jpeg");
  });

  it("unlinks the staged temp file when validation rejects the upload", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "media-test-"));
    const tmpPath = path.join(dir, "staged-upload");
    await fsp.writeFile(tmpPath, "fake bytes");

    await expect(
      svc.finalizeUpload(
        "ws1",
        makeFile({ mimetype: "video/x-msvideo", path: tmpPath }),
        "u1",
      ),
    ).rejects.toThrow(BadRequestException);

    await expect(fsp.access(tmpPath)).rejects.toBeTruthy();
  });

  it("unlinks the staged temp file after a successful upload", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "media-test-"));
    const tmpPath = path.join(dir, "staged-upload");
    await fsp.writeFile(tmpPath, "fake bytes");

    await svc.finalizeUpload("ws1", makeFile({ path: tmpPath }), "u1");

    await expect(fsp.access(tmpPath)).rejects.toBeTruthy();
  });
});
