import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import {
  defaultSafeDeps,
  parseConnectorUrl,
  parseSseMessages,
  pinnedLookup,
  safeFetch,
  SafeFetchError,
  type SafeFetchDeps,
  type SafeRequest,
} from "./safe-fetch";

function fake(dns: Record<string, string[]>, status = 200, body = "{}", headers: Record<string, string> = { "content-type": "application/json" }) {
  const calls: SafeRequest[] = [];
  const resolves: string[] = [];
  const deps: SafeFetchDeps = {
    async resolve(host) {
      resolves.push(host);
      return (dns[host] ?? []).map((a) => ({ address: a, family: a.includes(":") ? 6 : 4 }));
    },
    async request(req) {
      calls.push(req);
      return { status, headers, body: Readable.from([Buffer.from(body)]), abort: () => undefined };
    },
  };
  return { deps, calls, resolves };
}
const PROD = { NODE_ENV: "production" } as NodeJS.ProcessEnv;
const code = async (p: Promise<unknown>) => p.then(() => null, (e) => (e instanceof SafeFetchError ? `${e.code}:${e.reason}` : String(e)));

describe("connector safe-fetch", () => {
  it("custom connector url is ssrf-guarded", async () => {
    const refused = [
      "http://mcp.example.com/",
      "https://127.0.0.1/",
      "https://10.0.0.5/",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/",
      "https://[fd00::1]/",
      "https://[::ffff:10.0.0.1]/",
      "https://100.64.0.1/",
      "https://mcp.example.com:22/",
      "https://user:pw@mcp.example.com/",
      "https://localhost/",
      "https://intranet/",
    ];
    for (const url of refused) {
      const f = fake({});
      expect({ url, c: await code(safeFetch(url, { env: PROD }, f.deps)) }).toMatchObject({ url, c: expect.stringMatching(/^unsafe_url:/) });
      expect(f.calls).toHaveLength(0);
    }
    // A name with one public and one private address.
    const mixed = fake({ "mcp.example.com": ["93.184.216.34", "10.1.2.3"] });
    expect(await code(safeFetch("https://mcp.example.com/mcp", { env: PROD }, mixed.deps))).toBe("unsafe_url:private_address");
    expect(mixed.calls).toHaveLength(0);
    // A 302 is an error, never followed.
    const moved = fake({ "mcp.example.com": ["93.184.216.34"] }, 302, "", { location: "https://169.254.169.254/" });
    expect(await code(safeFetch("https://mcp.example.com/mcp", { env: PROD }, moved.deps))).toBe("redirect:http_302");
    expect(moved.calls).toHaveLength(1);
    // A public address is pinned: the socket connects to the checked IP even
    // if a second lookup would now return another (DNS rebinding).
    const ok = fake({ "mcp.example.com": ["93.184.216.34"] });
    const res = await safeFetch("https://mcp.example.com:8443/mcp", { env: PROD, body: "{}" }, ok.deps);
    expect(res.status).toBe(200);
    expect(ok.calls[0].pinned).toEqual({ address: "93.184.216.34", family: 4 });
    ok.deps.resolve = async () => [{ address: "127.0.0.1", family: 4 }];
    const looked = await new Promise<unknown[]>((r) => pinnedLookup(ok.calls[0].pinned!)("mcp.example.com", {}, (...a) => r(a)));
    expect(looked).toEqual([null, "93.184.216.34", 4]);
    expect(ok.calls[0].url.hostname).toBe("mcp.example.com"); // SNI/Host keep the name
  });

  it("caps the response and parses SSE answers", async () => {
    const big = fake({ "mcp.example.com": ["93.184.216.34"] }, 200, "x".repeat(2048));
    expect(await code(safeFetch("https://mcp.example.com/", { env: PROD, maxBytes: 1024 }, big.deps))).toBe("too_large:response_too_large");
    const cut = await safeFetch("https://mcp.example.com/", { env: PROD, maxBytes: 1024, truncate: true }, fake({ "mcp.example.com": ["93.184.216.34"] }, 200, "y".repeat(2048)).deps);
    expect(cut).toMatchObject({ truncated: true });
    expect(cut.body).toHaveLength(1024);
    expect(parseSseMessages('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n: keep-alive\n\ndata: not json\n\n')).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
  });

  it("curated loopback stubs are allowed only outside production", () => {
    expect(parseConnectorUrl("http://127.0.0.1:5555/mcp", { trusted: true, env: { NODE_ENV: "test" } as never }).port).toBe("5555");
    expect(() => parseConnectorUrl("http://127.0.0.1:5555/mcp", { trusted: true, env: PROD })).toThrow(SafeFetchError);
    expect(() => parseConnectorUrl("http://127.0.0.1:5555/mcp", { trusted: false, env: { NODE_ENV: "test" } as never })).toThrow(SafeFetchError);
  });

  it("the real transport posts to a loopback stub (trusted, test env)", async () => {
    let got = "";
    const server = http.createServer((req, res) => {
      req.on("data", (c) => (got += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s1" });
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await safeFetch(`http://127.0.0.1:${port}/mcp`, { trusted: true, body: '{"a":1}', headers: { "content-type": "application/json" }, env: { NODE_ENV: "test" } as never }, defaultSafeDeps());
      expect(res).toMatchObject({ status: 200, body: '{"ok":true}', headers: { "mcp-session-id": "s1" } });
      expect(got).toBe('{"a":1}');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
