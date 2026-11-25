/* eslint-disable @typescript-eslint/no-explicit-any */
import { fetchPageText, isPublicAddress, redactedUrl, type PageFetchDeps, type PageRequest, type ResolvedAddress } from "./fetch-page";

const PUBLIC = "93.184.216.34";

async function* body(...chunks: (string | Buffer)[]) {
  for (const c of chunks) yield Buffer.isBuffer(c) ? c : Buffer.from(c);
}

/** A scripted network: DNS answers and responses by URL. Any other call throws (no live calls). */
function net(opts: {
  dns?: Record<string, string[]>;
  pages?: Record<string, { status?: number; headers?: Record<string, string>; chunks?: (string | Buffer)[]; hang?: boolean }>;
}) {
  const requests: PageRequest[] = [];
  const deps: PageFetchDeps = {
    async resolve(host) {
      const a = opts.dns?.[host];
      if (!a) throw new Error(`unexpected DNS lookup: ${host}`);
      return a.map((address): ResolvedAddress => ({ address, family: address.includes(":") ? 6 : 4 }));
    },
    async request(req) {
      requests.push(req);
      const page = opts.pages?.[req.url.toString()];
      if (!page) throw new Error(`unexpected request: ${req.url}`);
      if (page.hang) {
        await new Promise((_, reject) => req.signal.addEventListener("abort", () => reject(new Error("aborted"))));
      }
      return {
        status: page.status ?? 200,
        headers: { "content-type": "text/html; charset=utf-8", ...(page.headers ?? {}) },
        body: body(...(page.chunks ?? ["<html><body>ok</body></html>"])),
        abort: () => undefined,
      };
    },
  };
  return { deps, requests };
}

async function key(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e: any) {
    return e.key ?? e.message;
  }
  return "resolved";
}

describe("page fetch refuses private and redirected-private hosts", () => {
  afterEach(() => delete process.env.CATALOG_FETCH_TEST_BASE);

  it("http:, credentials, other ports and junk → url_invalid", async () => {
    const { deps, requests } = net({});
    for (const url of ["http://example.com/", "https://u:p@example.com/", "https://example.com:8443/", "ftp://example.com", "not a url", "javascript:alert(1)"]) {
      expect({ url, k: await key(fetchPageText(url, 1000, deps)) }).toEqual({ url, k: "catalog_import.url_invalid" });
    }
    expect(requests).toHaveLength(0);
  });

  it("a host resolving to 10.0.0.5, 127.0.0.1, 169.254.169.254 or ::1 → url_blocked, before any request", async () => {
    for (const addr of ["10.0.0.5", "127.0.0.1", "169.254.169.254", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "100.64.1.1", "0.0.0.0"]) {
      const { deps, requests } = net({ dns: { "shop.example": [addr] } });
      expect({ addr, k: await key(fetchPageText("https://shop.example/menu", 1000, deps)) }).toEqual({ addr, k: "catalog_import.url_blocked" });
      expect(requests).toHaveLength(0);
    }
  });

  it("one private address among public ones is enough to refuse (no DNS split games)", async () => {
    const { deps } = net({ dns: { "shop.example": [PUBLIC, "192.168.1.10"] } });
    expect(await key(fetchPageText("https://shop.example/", 1000, deps))).toBe("catalog_import.url_blocked");
  });

  it("IP literals and localhost names are checked too", async () => {
    const { deps } = net({});
    for (const url of ["https://127.0.0.1/", "https://[::1]/", "https://169.254.169.254/latest/meta-data", "https://localhost/", "https://intranet/"]) {
      expect({ url, k: await key(fetchPageText(url, 1000, deps)) }).toEqual({ url, k: "catalog_import.url_blocked" });
    }
  });

  it("the connection is pinned to the checked address (DNS rebinding)", async () => {
    const { deps, requests } = net({
      dns: { "shop.example": [PUBLIC] },
      pages: { "https://shop.example/menu": { chunks: ["<p>Haircut 60 SAR</p>"] } },
    });
    expect(await fetchPageText("https://shop.example/menu", 1000, deps)).toBe("Haircut 60 SAR");
    expect(requests[0].pinned).toEqual({ address: PUBLIC, family: 4 });
  });

  it("a public host redirecting to a private one → url_blocked (checked on every hop)", async () => {
    const { deps, requests } = net({
      dns: { "shop.example": [PUBLIC], "evil.example": ["10.1.2.3"] },
      pages: { "https://shop.example/": { status: 302, headers: { location: "https://evil.example/admin" } } },
    });
    expect(await key(fetchPageText("https://shop.example/", 1000, deps))).toBe("catalog_import.url_blocked");
    expect(requests.map((r) => r.url.toString())).toEqual(["https://shop.example/"]);
    // A redirect to http: is refused too.
    const http = net({
      dns: { "shop.example": [PUBLIC] },
      pages: { "https://shop.example/": { status: 301, headers: { location: "http://shop.example/" } } },
    });
    expect(await key(fetchPageText("https://shop.example/", 1000, http.deps))).toBe("catalog_import.url_invalid");
  });

  it("≤ 3 redirects are followed; a 4th → url_fetch_failed", async () => {
    const hop = (n: number) => ({ status: 302, headers: { location: `/p${n}` } });
    const ok = net({
      dns: { "shop.example": [PUBLIC] },
      pages: {
        "https://shop.example/": hop(1),
        "https://shop.example/p1": hop(2),
        "https://shop.example/p2": hop(3),
        "https://shop.example/p3": { chunks: ["done"] },
      },
    });
    expect(await fetchPageText("https://shop.example/", 1000, ok.deps)).toBe("done");
    const tooMany = net({
      dns: { "shop.example": [PUBLIC] },
      pages: {
        "https://shop.example/": hop(1),
        "https://shop.example/p1": hop(2),
        "https://shop.example/p2": hop(3),
        "https://shop.example/p3": hop(4),
      },
    });
    expect(await key(fetchPageText("https://shop.example/", 1000, tooMany.deps))).toBe("catalog_import.url_fetch_failed");
  });

  it("> 2 MB (declared or streamed), application/pdf, an error status and a timeout → url_fetch_failed", async () => {
    const big = Buffer.alloc(1024 * 1024, 97);
    const cases = {
      "https://shop.example/big": { chunks: [big, big, Buffer.from("x")] },
      "https://shop.example/declared": { headers: { "content-length": String(3 * 1024 * 1024) } },
      "https://shop.example/pdf": { headers: { "content-type": "application/pdf" } },
      "https://shop.example/500": { status: 500 },
    };
    const { deps } = net({ dns: { "shop.example": [PUBLIC] }, pages: cases });
    for (const url of Object.keys(cases)) {
      expect({ url, k: await key(fetchPageText(url, 1000, deps)) }).toEqual({ url, k: "catalog_import.url_fetch_failed" });
    }
    jest.useFakeTimers();
    try {
      const slow = net({ dns: { "shop.example": [PUBLIC] }, pages: { "https://shop.example/slow": { hang: true } } });
      const p = key(fetchPageText("https://shop.example/slow", 1000, slow.deps));
      await jest.advanceTimersByTimeAsync(10_001);
      expect(await p).toBe("catalog_import.url_fetch_failed");
    } finally {
      jest.useRealTimers();
    }
  });

  it("plain text pages and HTML are reduced to text and capped", async () => {
    const { deps } = net({
      dns: { "shop.example": [PUBLIC] },
      pages: {
        "https://shop.example/a.txt": { headers: { "content-type": "text/plain" }, chunks: ["Haircut   45 min\r\n\r\nBeard 20 min"] },
        "https://shop.example/": {
          chunks: ["<title>Salon</title><script>steal()</script><style>p{}</style><ul><li>Cut &amp; wash</li><li>Beard</li></ul>"],
        },
      },
    });
    expect(await fetchPageText("https://shop.example/a.txt", 1000, deps)).toBe("Haircut 45 min\nBeard 20 min");
    expect(await fetchPageText("https://shop.example/", 1000, deps)).toBe("Salon\nCut & wash\nBeard");
    expect(await fetchPageText("https://shop.example/", 5, deps)).toBe("Salon");
  });

  it("CATALOG_FETCH_TEST_BASE is honoured only for http://127.0.0.1:<port>", async () => {
    process.env.CATALOG_FETCH_TEST_BASE = "http://127.0.0.1:4555";
    const local = net({ pages: { "http://127.0.0.1:4555/shop.example/menu?x=1": { chunks: ["stubbed"] } } });
    expect(await fetchPageText("https://shop.example/menu?x=1", 1000, local.deps)).toBe("stubbed");
    expect(local.requests[0].pinned).toBeNull();
    for (const bad of ["http://10.0.0.1:4555", "http://127.0.0.1:4555/extra", "https://127.0.0.1:4555", "http://localhost:4555"]) {
      process.env.CATALOG_FETCH_TEST_BASE = bad;
      const n = net({ dns: { "shop.example": ["10.0.0.9"] } });
      expect({ bad, k: await key(fetchPageText("https://shop.example/menu", 1000, n.deps)) }).toEqual({ bad, k: "catalog_import.url_blocked" });
    }
  });

  it("address policy and log redaction", () => {
    for (const a of ["8.8.8.8", PUBLIC, "2606:4700::1111"]) expect({ a, ok: isPublicAddress(a) }).toEqual({ a, ok: true });
    for (const a of ["10.0.0.1", "172.31.255.255", "192.168.0.1", "127.0.0.2", "169.254.169.254", "224.0.0.1", "255.255.255.255", "::", "::1", "fc00::1", "fe80::abcd", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a00:1", "2002:a00::1", "not-an-ip"]) {
      expect({ a, ok: isPublicAddress(a) }).toEqual({ a, ok: false });
    }
    expect(redactedUrl("https://shop.example/menu?token=secret#x")).toBe("https://shop.example/menu");
  });

  it("IPv4-compatible ::/96 (dotted or hex) and local NAT64 64:ff9b:1::/48 are blocked (review M1)", () => {
    for (const a of ["::7f00:1", "::a9fe:a9fe", "::a00:1", "::127.0.0.1", "::8.8.8.8", "::808:808", "[::7f00:1]", "64:ff9b:1::a00:1", "64:ff9b:1::808:808", "64:ff9b:1:ffff::1"]) {
      expect({ a, ok: isPublicAddress(a) }).toEqual({ a, ok: false });
    }
    // The well-known NAT64 prefix and the mapped form still decode to the IPv4 rule.
    for (const a of ["64:ff9b::808:808", "::ffff:8.8.8.8", "64:ff9b:2::1"]) expect({ a, ok: isPublicAddress(a) }).toEqual({ a, ok: true });
  });
});
