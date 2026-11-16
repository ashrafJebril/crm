/* eslint-disable @typescript-eslint/no-explicit-any */
import { fetchPublic, PublicFetchError, testBase, type PageFetchDeps, type PageRequest } from "./public-fetch";

const PUBLIC = "93.184.216.34";

function net(pages: Record<string, { status?: number; headers?: Record<string, string>; body?: string }>, dns: Record<string, string[]> = { "shop.example": [PUBLIC] }) {
  const requests: PageRequest[] = [];
  const deps: PageFetchDeps = {
    async resolve(host) {
      const a = dns[host];
      if (!a) throw new Error(`unexpected DNS lookup: ${host}`);
      return a.map((address) => ({ address, family: 4 as const }));
    },
    async request(req) {
      requests.push(req);
      const p = pages[req.url.toString()];
      if (!p) throw new Error(`unexpected request: ${req.url}`);
      return {
        status: p.status ?? 200,
        headers: { "Content-Type": "text/html", ...(p.headers ?? {}) },
        body: (async function* () {
          yield Buffer.from(p.body ?? "");
        })(),
        abort: () => undefined,
      };
    },
  };
  return { deps, requests };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof PublicFetchError ? e.code : String(e);
  }
  return "resolved";
};

describe("public fetch (shared by catalog import and the knowledge crawler)", () => {
  afterEach(() => {
    delete process.env.PUBLIC_FETCH_TEST_BASE;
    delete process.env.CATALOG_FETCH_TEST_BASE;
  });

  it("accepts only the caller's content types and sends its user agent", async () => {
    const n = net({
      "https://shop.example/robots.txt": { headers: { "Content-Type": "text/plain; charset=utf-8" }, body: "User-agent: *" },
      "https://shop.example/x.pdf": { headers: { "Content-Type": "application/pdf" } },
    });
    const ok = await fetchPublic("https://shop.example/robots.txt", { accept: ["text/plain"], userAgent: "KewyKnowledgeBot/1.0" }, n.deps);
    expect(ok).toMatchObject({ status: 200, contentType: "text/plain", body: "User-agent: *" });
    expect(n.requests[0].headers).toEqual({ accept: "text/plain", "user-agent": "KewyKnowledgeBot/1.0" });
    expect(await code(fetchPublic("https://shop.example/x.pdf", { accept: ["text/plain"] }, n.deps))).toBe("unsupported_type");
  });

  it("followRedirect can refuse a hop: the target is never requested", async () => {
    const n = net({ "https://shop.example/out": { status: 301, headers: { Location: "https://other.example/in" } } });
    const r = await fetchPublic("https://shop.example/out", { accept: ["text/html"], followRedirect: (_f, to) => to.hostname === "shop.example" }, n.deps);
    expect(r.redirectRefused?.toString()).toBe("https://other.example/in");
    expect(n.requests.map((q) => q.url.toString())).toEqual(["https://shop.example/out"]);
  });

  it("returnErrorStatus gives the status instead of failing", async () => {
    const n = net({ "https://shop.example/gone": { status: 404 }, "https://shop.example/locked": { status: 403 } });
    expect(await fetchPublic("https://shop.example/gone", { accept: ["text/html"], returnErrorStatus: true }, n.deps)).toMatchObject({ status: 404, body: "" });
    expect(await code(fetchPublic("https://shop.example/locked", { accept: ["text/html"] }, n.deps))).toBe("fetch_failed");
  });

  it("PUBLIC_FETCH_TEST_BASE (and its CATALOG_FETCH_TEST_BASE alias) only for http://127.0.0.1:<port>", () => {
    process.env.PUBLIC_FETCH_TEST_BASE = "http://127.0.0.1:4555";
    expect(testBase()).toBe("http://127.0.0.1:4555");
    process.env.PUBLIC_FETCH_TEST_BASE = "http://10.0.0.1:4555";
    expect(testBase()).toBeNull();
    delete process.env.PUBLIC_FETCH_TEST_BASE;
    process.env.CATALOG_FETCH_TEST_BASE = "http://127.0.0.1:4556";
    expect(testBase()).toBe("http://127.0.0.1:4556");
    process.env.CATALOG_FETCH_TEST_BASE = "http://localhost:4556";
    expect(testBase()).toBeNull();
  });

  it("a private address is refused before any request", async () => {
    const n = net({}, { "intranet.example": ["10.1.2.3"] });
    expect(await code(fetchPublic("https://intranet.example/", { accept: ["text/html"] }, n.deps))).toBe("url_blocked");
    expect(await code(fetchPublic("http://shop.example/", { accept: ["text/html"] }, n.deps))).toBe("url_invalid");
    expect(n.requests).toHaveLength(0);
  });
});
