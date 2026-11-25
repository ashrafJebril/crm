import { Logger } from "@nestjs/common";
import { makeFakePrisma } from "../channels/test-prisma";
import { WhatsAppService } from "../integrations/whatsapp.service";
import { AdReferralService } from "./ad-referral.service";
import {
  CREATIVE_MAX_BYTES,
  REHOST_CONCURRENCY,
  activeRehosts,
  creativeFetchTarget,
  creativeTestBase,
  makeFetchCreative,
  rehostCreative,
  type FetchCreative,
} from "./creative-rehost";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const IMG = "https://scontent.xx.fbcdn.net/v/t45/a.jpg?oh=1&oe=2";

/** A fetch double: every call is recorded; a URL with no route throws (no network). */
function fakeFetch(route: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return jest.fn(async (input: string | URL | Request, init?: RequestInit) => route(String(input), init ?? {}));
}
const ok = (body: Buffer | string, type = "image/png", extra: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : new Uint8Array(body), { status: 200, headers: { "content-type": type, ...extra } });

describe("creative fetch rules", () => {
  it("only https on *.fbcdn.net is fetched", () => {
    expect(creativeFetchTarget(IMG, {})).toBe(IMG);
    expect(() => creativeFetchTarget("http://scontent.xx.fbcdn.net/a.jpg", {})).toThrow("creative_not_https");
    expect(() => creativeFetchTarget("https://evil.example.com/a.jpg", {})).toThrow("creative_host_refused");
    expect(() => creativeFetchTarget("https://fbcdn.net.evil.com/a.jpg", {})).toThrow("creative_host_refused");
    expect(() => creativeFetchTarget("https://u:p@a.fbcdn.net/a.jpg", {})).toThrow("creative_host_refused");
    expect(() => creativeFetchTarget("https://a.fbcdn.net:8443/a.jpg", {})).toThrow("creative_host_refused");
    expect(() => creativeFetchTarget("not a url", {})).toThrow("creative_not_https");
  });

  it("META_CDN_TEST_BASE is honoured only for http://127.0.0.1:<port>", () => {
    expect(creativeTestBase({ META_CDN_TEST_BASE: "http://127.0.0.1:4010" })).toBe("http://127.0.0.1:4010");
    for (const bad of ["http://localhost:4010", "https://127.0.0.1:4010", "http://127.0.0.1", "http://127.0.0.1:99999", "http://10.0.0.1:80", "http://127.0.0.1:4010/x"]) {
      expect(creativeTestBase({ META_CDN_TEST_BASE: bad })).toBeNull();
      expect(creativeFetchTarget(IMG, { META_CDN_TEST_BASE: bad })).toBe(IMG);
    }
    expect(creativeFetchTarget(IMG, { META_CDN_TEST_BASE: "http://127.0.0.1:4010" })).toBe(
      "http://127.0.0.1:4010/scontent.xx.fbcdn.net/v/t45/a.jpg?oh=1&oe=2",
    );
    // The host rules still apply before the rewrite.
    expect(() => creativeFetchTarget("https://evil.example.com/a.jpg", { META_CDN_TEST_BASE: "http://127.0.0.1:4010" })).toThrow(
      "creative_host_refused",
    );
  });

  it("META_CDN_TEST_BASE is ignored in production or on Fly, and warns when active", () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    warn.mockClear();
    const base = "http://127.0.0.1:4010";
    for (const env of [
      { META_CDN_TEST_BASE: base, NODE_ENV: "production" },
      { META_CDN_TEST_BASE: base, FLY_APP_NAME: "crm-api" },
    ]) {
      expect(creativeTestBase(env)).toBeNull();
      expect(creativeFetchTarget(IMG, env)).toBe(IMG);
    }
    expect(warn.mock.calls.some((c) => String(c[0]).includes("META_CDN_TEST_BASE"))).toBe(false);
    expect(creativeFetchTarget(IMG, { META_CDN_TEST_BASE: base, NODE_ENV: "test" })).toContain(base);
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("META_CDN_TEST_BASE is active"))).toBe(true);
    for (const l of lines) expect(l).not.toContain("fbcdn");
  });

  it("refuses redirects, non-images, oversize bodies and slow hosts", async () => {
    const run = (res: () => Response | Promise<Response>, opts: { timeoutMs?: number } = {}) =>
      makeFetchCreative({ fetchImpl: fakeFetch(() => res()) as never, ...opts })(IMG);
    await expect(run(() => new Response(null, { status: 302, headers: { location: "https://evil.example.com" } }))).rejects.toThrow("creative_redirect");
    await expect(run(() => ok("<html>", "text/html"))).rejects.toThrow("creative_not_image");
    await expect(run(() => new Response("x", { status: 403, headers: { "content-type": "image/png" } }))).rejects.toThrow("creative_http_error");
    await expect(run(() => ok(PNG, "image/png", { "content-length": String(CREATIVE_MAX_BYTES + 1) }))).rejects.toThrow("creative_too_large");
    await expect(run(() => ok(Buffer.alloc(CREATIVE_MAX_BYTES + 1)))).rejects.toThrow("creative_too_large");
    await expect(
      makeFetchCreative({
        timeoutMs: 20,
        fetchImpl: fakeFetch(
          (_u, init) =>
            new Promise<Response>((_r, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
        ) as never,
      })(IMG),
    ).rejects.toThrow("creative_timeout");
    await expect(run(() => ok(PNG))).resolves.toMatchObject({ mimeType: "image/png" });
  });

  it("never follows redirects (redirect: manual)", async () => {
    const f = fakeFetch(() => ok(PNG));
    await makeFetchCreative({ fetchImpl: f as never })(IMG);
    expect(f.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  });
});

describe("creative is re-hosted once with strict fetch rules", () => {
  const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  afterAll(() => warn.mockRestore());

  function world(route: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const prisma = makeFakePrisma({
      channel: [
        {
          id: "M",
          workspaceId: "ws1",
          kind: "whatsapp",
          provider: "meta",
          externalId: "pn-M",
          status: "active",
          isDefault: true,
          integrationId: null,
          createdAt: new Date("2026-01-01"),
          updatedAt: new Date("2026-01-01"),
        },
      ],
    });
    const fetchImpl = fakeFetch(route);
    let n = 0;
    const media = {
      ingestBuffer: jest.fn(async (i: { workspaceId: string }) => ({ id: `media_${++n}`, workspaceId: i.workspaceId })),
    };
    const ads = new AdReferralService(prisma, media as never, makeFetchCreative({ fetchImpl: fetchImpl as never, timeoutMs: 30 }));
    const wa = new WhatsAppService(
      prisma,
      { emitToWorkspace: jest.fn() } as never,
      {} as never,
      { onInboundMessage: jest.fn(async () => {}) } as never,
      { isConfigured: () => false } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      ads,
    );
    let k = 0;
    const send = async (referral: Record<string, unknown>) => {
      k++;
      const res = await wa.handleWebhook({
        object: "whatsapp_business_account",
        entry: [
          {
            id: "waba",
            changes: [
              {
                field: "messages",
                value: {
                  metadata: { phone_number_id: "pn-M" },
                  contacts: [{ wa_id: "962790000001" }],
                  messages: [{ from: "962790000001", id: `wamid.${k}`, timestamp: String(1_763_000_000 + k), type: "text", text: { body: "hi" }, referral }],
                },
              },
            ],
          },
        ],
      } as never);
      await ads.drain();
      return res;
    };
    return { prisma, fetchImpl, media, send };
  }

  const image = (url: string, id = "1") => ({ source_id: id, source_type: "ad", media_type: "image", image_url: url, headline: "H" });

  it("an fbcdn https image is fetched once and a second referral fetches nothing", async () => {
    const w = world(() => ok(PNG));
    await w.send(image(IMG));
    expect(w.fetchImpl).toHaveBeenCalledTimes(1);
    expect(w.media.ingestBuffer).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws1", mimeType: "image/png", fileName: "ad-1" }));
    expect(w.prisma.db.adSource[0].mediaId).toBe("media_1");
    await w.send(image(IMG));
    expect(w.fetchImpl).toHaveBeenCalledTimes(1);
    expect(w.prisma.db.adReferral).toHaveLength(2);
  });

  it("a video ad fetches its thumbnail_url", async () => {
    const w = world(() => ok(PNG, "image/jpeg"));
    await w.send({ source_id: "2", source_type: "ad", media_type: "video", video_url: "https://v.fbcdn.net/v.mp4", thumbnail_url: "https://v.fbcdn.net/t.jpg" });
    expect(w.fetchImpl.mock.calls.map((c) => String(c[0]))).toEqual(["https://v.fbcdn.net/t.jpg"]);
    expect(w.prisma.db.adSource[0].mediaId).toBe("media_1");
  });

  it.each([
    ["an http: link", image("http://scontent.fbcdn.net/a.jpg"), () => ok(PNG), 0],
    ["a non-fbcdn host", image("https://cdn.example.com/a.jpg"), () => ok(PNG), 0],
    ["a redirect", image(IMG), () => new Response(null, { status: 301, headers: { location: "https://x.fbcdn.net/b.jpg" } }), 1],
    ["text/html", image(IMG), () => ok("<html></html>", "text/html"), 1],
    ["> 5 MB", image(IMG), () => ok(Buffer.alloc(CREATIVE_MAX_BYTES + 10)), 1],
    ["a timeout", image(IMG), (_u: string, init: RequestInit) => new Promise<Response>((_r, rej) => init.signal?.addEventListener("abort", () => rej(new Error("abort")))), 1],
  ] as const)("%s → no Media, mediaId null, a logged key, inbound unaffected", async (_name, ref, route, fetches) => {
    warn.mockClear();
    const w = world(route as never);
    const res = await w.send(ref);
    expect(res).toMatchObject({ ok: true });
    expect(w.prisma.db.message).toHaveLength(1);
    expect(w.prisma.db.adReferral).toHaveLength(1);
    expect(w.fetchImpl).toHaveBeenCalledTimes(fetches);
    expect(w.media.ingestBuffer).not.toHaveBeenCalled();
    const src = w.prisma.db.adSource[0];
    expect(src.mediaId).toBeNull();
    const lines = warn.mock.calls.map((c) => String(c[0]));
    if (src.mediaUrl) {
      expect(lines.some((l) => /^creative_rehost_failed key=creative_[a-z_]+ adSource=/.test(l))).toBe(true);
    } else {
      // An http: link never reaches the row at all (the parser drops it to null).
      expect(_name).toBe("an http: link");
    }
    for (const l of lines) expect(l).not.toContain("fbcdn");
  });

  it("a failed re-host is retried on the next referral of the same ad", async () => {
    let fail = true;
    const w = world(() => (fail ? ok("<html>", "text/html") : ok(PNG)));
    await w.send(image(IMG));
    expect(w.prisma.db.adSource[0].mediaId).toBeNull();
    fail = false;
    await w.send(image("https://scontent.xx.fbcdn.net/v/t45/a.jpg?oh=fresh"));
    expect(w.fetchImpl).toHaveBeenCalledTimes(2);
    // The fresh signed link replaced the old one before the retry.
    expect(String(w.fetchImpl.mock.calls[1][0])).toContain("oh=fresh");
    expect(w.prisma.db.adSource[0].mediaId).toBe("media_1");
  });

  it("at most 2 re-hosts run at a time, and one ad is fetched once while in flight", async () => {
    const prisma = makeFakePrisma({});
    let peak = 0;
    const release: Array<() => void> = [];
    const fetchCreative: FetchCreative = jest.fn(
      () =>
        new Promise((resolve) => {
          peak = Math.max(peak, activeRehosts());
          release.push(() => resolve({ buffer: PNG, mimeType: "image/png" }));
        }),
    );
    const media = { ingestBuffer: jest.fn(async () => ({ id: `m${Math.random()}` })) };
    const target = (i: number) => ({ id: `s${i}`, workspaceId: "ws1", sourceId: String(i), mediaId: null, mediaUrl: IMG });
    const runs = [1, 2, 3, 4].map((i) => rehostCreative(target(i), { prisma, media, fetchCreative }));
    const dup = rehostCreative(target(1), { prisma, media, fetchCreative });
    for (let i = 0; i < 10 && release.length < REHOST_CONCURRENCY; i++) await new Promise((r) => setImmediate(r));
    expect(release).toHaveLength(REHOST_CONCURRENCY);
    while (release.length) {
      release.shift()!();
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    }
    await Promise.all([...runs, dup]);
    expect(peak).toBeLessThanOrEqual(REHOST_CONCURRENCY);
    expect(fetchCreative).toHaveBeenCalledTimes(4);
  });

  it("a finishing re-host hands its slot to the waiter, so a newcomer cannot push it to 3", async () => {
    const prisma = makeFakePrisma({});
    let peak = 0;
    const running = new Map<string, () => void>();
    const fetchCreative: FetchCreative = jest.fn(
      (url: string) =>
        new Promise((resolve) => {
          peak = Math.max(peak, activeRehosts());
          running.set(url, () => resolve({ buffer: PNG, mimeType: "image/png" }));
        }),
    );
    const media = { ingestBuffer: jest.fn(async () => ({ id: `m${Math.random()}` })) };
    const target = (i: number) => ({ id: `h${i}`, workspaceId: "ws1", sourceId: String(i), mediaId: null, mediaUrl: `${IMG}&n=${i}` });
    const tick = async (n = 5) => {
      for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
    };
    const runs = [1, 2, 3].map((i) => rehostCreative(target(i), { prisma, media, fetchCreative }));
    await tick();
    expect(running.size).toBe(2);
    // Release one; a newcomer starts in the same turn, before the waiter resumes.
    const first = [...running.keys()][0];
    running.get(first)!();
    running.delete(first);
    // The slot is handed over: the count never dips while a waiter is queued,
    // so no newcomer can slip in between (old code: 2 -> 1 -> newcomer 2 -> waiter 3).
    const samples: number[] = [];
    for (let i = 0; i < 40; i++) {
      samples.push(activeRehosts());
      await Promise.resolve();
    }
    expect(Math.min(...samples)).toBe(REHOST_CONCURRENCY);
    expect(running.size).toBe(2);
    runs.push(rehostCreative(target(4), { prisma, media, fetchCreative }));
    await tick();
    expect(activeRehosts()).toBeLessThanOrEqual(REHOST_CONCURRENCY);
    while (running.size) {
      const [k, done] = [...running.entries()][0];
      running.delete(k);
      done();
      await tick();
      expect(activeRehosts()).toBeLessThanOrEqual(REHOST_CONCURRENCY);
    }
    await Promise.all(runs);
    expect(peak).toBeLessThanOrEqual(REHOST_CONCURRENCY);
    expect(activeRehosts()).toBe(0);
    expect(fetchCreative).toHaveBeenCalledTimes(4);
  });
});
