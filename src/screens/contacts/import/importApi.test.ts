import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

async function load() {
  vi.resetModules();
  const client = await import("@/api/client");
  const importApi = await import("./importApi");
  return { client, importApi };
}

const csvResponse = (status = 200, body: BodyInit = "id\r\n1\r\n", headers: Record<string, string> = {}) =>
  new Response(body, { status, headers });

describe("exportBody", () => {
  it("sends the filter and the selected ids", async () => {
    const { importApi } = await load();
    const q = new URLSearchParams({ q: "sara", tags: '["VIP"]', lifecycle: "lead,customer" }).toString();
    expect(importApi.exportBody(q, ["a", "b"], false)).toEqual({
      q: "sara", tags: '["VIP"]', lifecycle: "lead,customer", ids: ["a", "b"],
    });
  });
  it("sends only the filter for select-all, and when nothing is selected", async () => {
    const { importApi } = await load();
    expect(importApi.exportBody("q=x", ["a", "b"], true)).toEqual({ q: "x" });
    expect(importApi.exportBody("q=x", [], false)).toEqual({ q: "x" });
  });
});

describe("downloadContactsExport", () => {
  it("POSTs the JSON body through the shared client (token in a header, never in the URL) and saves the file", async () => {
    const { client, importApi } = await load();
    client.tokenStore.set("tok-1");
    const fetchMock = vi.fn(async () =>
      csvResponse(200, "id\r\n1\r\n", { "Content-Disposition": 'attachment; filename="contacts-2026-11-09.csv"' }));
    vi.stubGlobal("fetch", fetchMock);
    const a = { href: "", download: "", click: vi.fn(), remove: vi.fn() };
    vi.stubGlobal("document", { createElement: () => a, body: { appendChild: vi.fn() } });
    vi.stubGlobal("URL", { createObjectURL: () => "blob:x", revokeObjectURL: vi.fn() });
    vi.stubGlobal("window", { setTimeout: vi.fn() });

    const ids = Array.from({ length: 5000 }, (_, i) => `id${i}`);
    await importApi.downloadContactsExport("lifecycle=lead", ids);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url.endsWith("/contacts/export")).toBe(true);
    expect(url).not.toContain("tok-1");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-1");
    expect(JSON.parse(init.body as string)).toEqual({ lifecycle: "lead", ids });
    expect(a.download).toBe("contacts-2026-11-09.csv");
    expect(a.click).toHaveBeenCalled();
  });

  it("a 401 with a token fires the global unauthorized handler; errors carry status and message", async () => {
    const { client, importApi } = await load();
    client.tokenStore.set("tok-1");
    const onUnauthorized = vi.fn();
    client.setUnauthorizedHandler(onUnauthorized);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "ids is limited to 10000" }), { status: 400 })));
    await expect(importApi.downloadContactsExport("", ["a"])).rejects.toMatchObject({ status: 400, message: "ids is limited to 10000" });
    expect(onUnauthorized).not.toHaveBeenCalled();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    await expect(importApi.downloadContactsExport("", [])).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});

describe("uploadImport", () => {
  it("sends multipart without a JSON content type, with the token, and maps the error key", async () => {
    const { client, importApi } = await load();
    client.tokenStore.set("tok-2");
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ message: "imports.too_many_rows", messageKey: "imports.too_many_rows" }), { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["a,b"], "a.csv", { type: "text/csv" });
    const err = await importApi.uploadImport(file, "contacts").catch((e) => e);
    expect(importApi.errorKey(err)).toBe("imports.too_many_rows");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get("kind")).toBe("contacts");
    const h = init.headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer tok-2");
    expect(h["Content-Type"]).toBeUndefined();
  });

  it("a 401 logs the session out", async () => {
    const { client, importApi } = await load();
    client.tokenStore.set("tok-2");
    const onUnauthorized = vi.fn();
    client.setUnauthorizedHandler(onUnauthorized);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    await importApi.uploadImport(new File(["x"], "a.csv"), "audience").catch(() => undefined);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});
