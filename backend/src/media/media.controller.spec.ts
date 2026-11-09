import { BadRequestException } from "@nestjs/common";
import { MediaController } from "./media.controller";

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
  const build = () => {
    const svc = { list: jest.fn(async () => []) };
    return { svc, ctrl: new MediaController(svc as never) };
  };
  const viewer = { userId: "u" } as never;

  it("passes kind, before and limit through", async () => {
    const { svc, ctrl } = build();
    await ctrl.list("ws", viewer, "document", "m9", "50");
    expect(svc.list).toHaveBeenCalledWith("ws", viewer, { kind: "document", before: "m9", limit: 50 });
  });

  it("no query keeps today's default (array of up to 200, newest first)", async () => {
    const { svc, ctrl } = build();
    await ctrl.list("ws", viewer);
    expect(svc.list).toHaveBeenCalledWith("ws", viewer, { kind: undefined, before: undefined, limit: undefined });
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
        ctrl.list("ws", viewer, ...(args as unknown as [string?, string?, string?]));
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({ message: "media.invalid_query", param });
    }
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
