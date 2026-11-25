import * as http from "node:http";
import type { AddressInfo } from "node:net";
import {
  defaultSafeDeps,
  loopbackEscapeAllowed,
  parseSafeUrl,
  pinnedLookup,
  safePost,
  UnsafeUrlError,
  type SafeFetchDeps,
  type SafeRequest,
} from "./safe-fetch";

/** A transport that records requests and never opens a socket. */
function fakeDeps(addrs: Record<string, string[]>, status = 200): SafeFetchDeps & { calls: SafeRequest[]; resolves: string[] } {
  const calls: SafeRequest[] = [];
  const resolves: string[] = [];
  return {
    calls,
    resolves,
    async resolve(host) {
      resolves.push(host);
      return (addrs[host] ?? []).map((a) => ({ address: a, family: a.includes(":") ? 6 : 4 }));
    },
    async request(req) {
      calls.push(req);
      return { status };
    },
  };
}

const NO_ESCAPE = { NODE_ENV: "test" } as NodeJS.ProcessEnv;

describe("safeFetch", () => {
  it("safeFetch refuses private, loopback, link-local and metadata addresses", async () => {
    const literals = [
      "10.0.0.5",
      "172.16.3.4",
      "192.168.1.1",
      "127.0.0.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "[::1]",
      "[fc00::1]",
      "[fe80::1]",
      "[::ffff:127.0.0.1]",
    ];
    for (const ip of literals) {
      const deps = fakeDeps({});
      const err = await safePost(`https://${ip}/hook`, "{}", {}, deps, { env: NO_ESCAPE }).catch((e) => e);
      expect({ ip, unsafe: err instanceof UnsafeUrlError }).toEqual({ ip, unsafe: true });
      expect(deps.calls).toHaveLength(0);
    }
    // A hostname resolving to any of them (one private record is enough).
    for (const bad of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "::1", "fc00::2", "::ffff:127.0.0.1", "100.64.9.9"]) {
      const deps = fakeDeps({ "hooks.example.com": ["93.184.216.34", bad] });
      const err = await safePost("https://hooks.example.com/x", "{}", {}, deps, { env: NO_ESCAPE }).catch((e) => e);
      expect({ bad, unsafe: err instanceof UnsafeUrlError }).toEqual({ bad, unsafe: true });
      expect(deps.calls).toHaveLength(0);
    }
    // Scheme, port, credentials, single-label hosts.
    for (const url of [
      "http://hooks.example.com/x",
      "https://hooks.example.com:22/x",
      "https://user:pw@hooks.example.com/x",
      "https://localhost/x",
      "https://intranet/x",
      "ftp://hooks.example.com/x",
      "not a url",
    ]) {
      expect({ url, unsafe: (() => { try { parseSafeUrl(url, NO_ESCAPE); return false; } catch (e) { return e instanceof UnsafeUrlError; } })() }).toEqual({ url, unsafe: true });
    }
    // Public https on 443 and 8443 is fine.
    expect(parseSafeUrl("https://hooks.example.com/x", NO_ESCAPE).host).toBe("hooks.example.com");
    expect(parseSafeUrl("https://hooks.example.com:8443/x", NO_ESCAPE).port).toBe("8443");
  });

  it("safeFetch pins the validated ip", async () => {
    const deps = fakeDeps({ "hooks.example.com": ["93.184.216.34"] });
    const res = await safePost("https://hooks.example.com/x", "{}", { a: "b" }, deps, { env: NO_ESCAPE });
    expect(res).toEqual({ status: 200, ok: true, error: null });
    expect(deps.calls[0].pinned).toEqual({ address: "93.184.216.34", family: 4 });
    expect(deps.calls[0].method).toBe("POST");
    // The socket lookup answers with the checked address, whatever a second
    // resolution would now say (DNS rebinding to 127.0.0.1 is ignored).
    const lookup = pinnedLookup(deps.calls[0].pinned!);
    const one = await new Promise<unknown[]>((r) => lookup("hooks.example.com", {}, (...a) => r(a)));
    expect(one).toEqual([null, "93.184.216.34", 4]);
    const all = await new Promise<unknown[]>((r) => lookup("hooks.example.com", { all: true }, (...a) => r(a)));
    expect(all).toEqual([null, [{ address: "93.184.216.34", family: 4 }]]);
    expect(deps.resolves).toEqual(["hooks.example.com"]);
  });

  it("redirect is a failure", async () => {
    for (const status of [301, 302, 307, 308]) {
      const deps = fakeDeps({ "hooks.example.com": ["93.184.216.34"] }, status);
      expect(await safePost("https://hooks.example.com/x", "{}", {}, deps, { env: NO_ESCAPE })).toEqual({ status, ok: false, error: "redirect" });
      expect(deps.calls).toHaveLength(1); // the Location is never requested
    }
    const deps = fakeDeps({ "hooks.example.com": ["93.184.216.34"] }, 500);
    expect(await safePost("https://hooks.example.com/x", "{}", {}, deps, { env: NO_ESCAPE })).toEqual({ status: 500, ok: false, error: "http_500" });
    const failing: SafeFetchDeps = { resolve: async () => [{ address: "93.184.216.34", family: 4 }], request: async () => Promise.reject(new Error("ECONNRESET secret=abc")) };
    expect(await safePost("https://hooks.example.com/x", "{}", {}, failing, { env: NO_ESCAPE })).toEqual({ status: 0, ok: false, error: "network_error" });
  });

  it("test loopback escape refused on Fly or with a wrong value", () => {
    const url = "http://127.0.0.1:4567/hook";
    expect(loopbackEscapeAllowed({ WEBHOOK_TEST_LOOPBACK: "zz-verify", NODE_ENV: "test" } as never)).toBe(true);
    for (const env of [
      { WEBHOOK_TEST_LOOPBACK: "zz-verify", FLY_APP_NAME: "crm-backend", NODE_ENV: "test" },
      { WEBHOOK_TEST_LOOPBACK: "zz-verify", NODE_ENV: "production" },
      { WEBHOOK_TEST_LOOPBACK: "yes", NODE_ENV: "test" },
      { WEBHOOK_TEST_LOOPBACK: "", NODE_ENV: "test" },
      { NODE_ENV: "test" },
    ]) {
      expect({ env, allowed: loopbackEscapeAllowed(env as never) }).toEqual({ env, allowed: false });
      expect(() => parseSafeUrl(url, env as never)).toThrow(UnsafeUrlError);
    }
    // Even with the escape on, only 127.0.0.1 over http is let through.
    const on = { WEBHOOK_TEST_LOOPBACK: "zz-verify", NODE_ENV: "test" } as never;
    expect(parseSafeUrl(url, on).toString()).toBe(url);
    for (const other of ["http://localhost:4567/x", "http://10.0.0.1:4567/x", "http://127.0.0.2:4567/x"]) {
      expect(() => parseSafeUrl(other, on)).toThrow(UnsafeUrlError);
    }
  });

  it("the real HTTP path POSTs the body and headers to a loopback receiver (escape on)", async () => {
    const got: { method?: string; headers?: http.IncomingHttpHeaders; body?: string } = {};
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        Object.assign(got, { method: req.method, headers: req.headers, body });
        res.writeHead(202, { "content-type": "text/plain" });
        res.end("x".repeat(10_000)); // read to 2 KB and dropped
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as AddressInfo).port;
      const env = { WEBHOOK_TEST_LOOPBACK: "zz-verify", NODE_ENV: "test" } as never;
      const res = await safePost(`http://127.0.0.1:${port}/hook`, '{"a":1}', { "x-crm-event": "ping" }, defaultSafeDeps(), { env });
      expect(res).toEqual({ status: 202, ok: true, error: null });
      expect(got).toMatchObject({ method: "POST", body: '{"a":1}', headers: { "x-crm-event": "ping", "content-length": "7" } });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
