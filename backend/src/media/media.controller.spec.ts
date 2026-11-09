import { BadRequestException } from "@nestjs/common";
import { applyServeHeaders, MediaController } from "./media.controller";

function fakeRes() {
  const headers: Record<string, string> = {};
  return {
    headers,
    setHeader: jest.fn((k: string, v: string) => {
      headers[k.toLowerCase()] = String(v);
    }),
    sendFile: jest.fn(),
    redirect: jest.fn(),
  };
}

describe("MediaController.list query parsing", () => {
  const build = (nextBefore: string | null = null) => {
    const svc = { listPage: jest.fn(async () => ({ items: [{ id: "a" }], nextBefore })) };
    return { svc, ctrl: new MediaController(svc as never) };
  };
  const viewer = { userId: "u" } as never;

  it("passes kind, before and limit through and returns the plain array", async () => {
    const { svc, ctrl } = build();
    const res = fakeRes();
    expect(await ctrl.list("ws", viewer, res as never, "document", "m9", "50")).toEqual([{ id: "a" }]);
    expect(svc.listPage).toHaveBeenCalledWith("ws", viewer, { kind: "document", before: "m9", limit: 50 });
  });

  it("accepts kind=all", async () => {
    const { svc, ctrl } = build();
    await ctrl.list("ws", viewer, fakeRes() as never, "all");
    expect(svc.listPage).toHaveBeenCalledWith("ws", viewer, { kind: "all", before: undefined, limit: undefined });
  });

  it("no query keeps today's default (array of up to 200, newest first)", async () => {
    const { svc, ctrl } = build();
    await ctrl.list("ws", viewer, fakeRes() as never);
    expect(svc.listPage).toHaveBeenCalledWith("ws", viewer, { kind: undefined, before: undefined, limit: undefined });
  });

  it("X-Media-Next-Before carries the scan position; absent at the true end", async () => {
    const more = build("m7");
    const res = fakeRes();
    await more.ctrl.list("ws", viewer, res as never, "all", undefined, "60");
    expect(res.headers["x-media-next-before"]).toBe("m7");
    const end = build(null);
    const res2 = fakeRes();
    await end.ctrl.list("ws", viewer, res2 as never, "all", undefined, "60");
    expect(res2.headers["x-media-next-before"]).toBeUndefined();
  });

  it("rejects a bad kind or limit with 400 media.invalid_query {param}", () => {
    const { ctrl } = build();
    for (const [args, param] of [
      [["svg"], "kind"],
      [[undefined, undefined, "0"], "limit"],
      [[undefined, undefined, "201"], "limit"],
      [[undefined, undefined, "abc"], "limit"],
      [[undefined, undefined, "2.5"], "limit"],
    ] as const) {
      let err: any;
      try {
        ctrl.list("ws", viewer, fakeRes() as never, ...(args as unknown as [string?, string?, string?]));
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({ message: "media.invalid_query", param });
    }
  });
});

describe("filename* is RFC 5987 encoded", () => {
  it("percent-encodes ' ( ) * as well, with an Arabic name", () => {
    const res = fakeRes();
    applyServeHeaders(res as never, "application/pdf", "عرض O'Brien (final)*.pdf");
    const star = res.headers["content-disposition"].split("filename*=UTF-8''")[1];
    expect(star).toBe(
      "%D8%B9%D8%B1%D8%B6%20O%27Brien%20%28final%29%2A.pdf",
    );
    // attr-char only: ALPHA / DIGIT / ! # $ & + - . ^ _ ` | ~ and pct-encoded
    expect(star).toMatch(/^[A-Za-z0-9!#$&+\-.^_`|~%]+$/);
    expect(decodeURIComponent(star)).toBe("عرض O'Brien (final)*.pdf");
  });
});

describe("pdf is served as attachment with nosniff and sandbox CSP", () => {
  const build = (mimeType: string, fileName = "menu.pdf") => {
    const svc = {
      resolveServe: jest.fn(async () => ({ kind: "local-file", absolutePath: "/x/f", mimeType, fileName })),
      findByPublicToken: jest.fn(async () => ({ id: "m1", mimeType, fileName, storageKind: "local" })),
      resolveServeForRow: jest.fn(async () => ({ kind: "local-file", absolutePath: "/x/f", mimeType, fileName })),
    };
    return { svc, ctrl: new MediaController(svc as never) };
  };

  it("a PDF is an attachment, sandboxed and nosniff", async () => {
    const { ctrl } = build("application/pdf", "قائمة menu.pdf");
    const res = fakeRes();
    await ctrl.serve("ws", "m1", res as never, { userId: "u" } as never);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBe("sandbox");
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="[^"]*"; filename\*=UTF-8''/);
    expect(res.headers["content-disposition"]).toContain(encodeURIComponent("قائمة menu.pdf"));
    // The ASCII fallback never carries a quote or a non-ASCII byte.
    expect(res.headers["content-disposition"].split(";")[1]).toMatch(/^ filename="[\x20-\x7e]*"$/);
    expect(res.sendFile).toHaveBeenCalledWith("/x/f");
  });

  it("the public link applies the same headers", async () => {
    const { ctrl } = build("application/pdf");
    const res = fakeRes();
    await ctrl.servePublic("m1", "tok", res as never);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-disposition"]).toMatch(/^attachment;/);
    expect(res.headers["content-security-policy"]).toBe("sandbox");
  });

  it("images and videos stay inline (nosniff only)", async () => {
    for (const mime of ["image/png", "image/jpeg", "video/mp4"]) {
      const { ctrl } = build(mime, "a");
      const res = fakeRes();
      await ctrl.serve("ws", "m1", res as never, { userId: "u" } as never);
      expect(res.headers["content-type"]).toBe(mime);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["content-disposition"]).toBeUndefined();
      expect(res.headers["content-security-policy"]).toBeUndefined();
    }
  });

  it("legacy non-library types (CSV, anything unknown) are attachments too", async () => {
    const { ctrl } = build("text/csv", "contacts.csv");
    const res = fakeRes();
    await ctrl.serve("ws", "m1", res as never, { userId: "u" } as never);
    expect(res.headers["content-disposition"]).toMatch(/^attachment;/);
    expect(res.headers["content-security-policy"]).toBe("sandbox");
  });
});
