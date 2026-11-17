/* eslint-disable @typescript-eslint/no-explicit-any */
import { crawlWorld, fakeNet, html, PUBLIC_IP, website, A } from "./crawl-test-world";
import { CrawlRunner, PAGE_MIN_BODY_CHARS } from "./crawl-runner";
import type { PageFetchDeps } from "../../common/public-fetch";
import { APPLY_TX_MAX_WAIT_MS, APPLY_TX_TIMEOUT_MS, CAPPED_ROW_SAMPLE, MIN_REQUEST_GAP_MS, SITEMAP_URL_CAP } from "./crawl-runner";
import { WEBSITE_PAGE_CAP } from "../knowledge-constants";

const ROBOTS = [
  "User-agent: *",
  "Disallow: /private",
  "",
  "User-agent: KewyKnowledgeBot",
  "Allow: /private/menu",
  "Disallow: /private",
].join("\n");
const robots = (body = ROBOTS) => ({ headers: { "content-type": "text/plain" }, body });
const notFound = { status: 404 };
const SHOP = { "shop.example": [PUBLIC_IP], "www.shop.example": [PUBLIC_IP] };

/** Pages of a crawl that are not robots.txt or a sitemap. */
const pageUrls = (urls: string[]) => urls.filter((u) => !/\/(robots\.txt|sitemap\.xml)$/.test(u));

describe("CrawlRunner", () => {
  it("crawler respects robots.txt and same-origin", async () => {
    const net = fakeNet({
      dns: SHOP,
      pages: {
        "https://shop.example/robots.txt": robots(),
        "https://shop.example/sitemap.xml": {
          headers: { "content-type": "application/xml" },
          body: "<urlset><url><loc>https://cdn.other.example/y</loc></url><url><loc>https://shop.example/about</loc></url></urlset>",
        },
        "https://shop.example/": {
          body: html("Home", "Welcome to the shop, open every day of the week.", [
            "/about",
            "/private/menu",
            "/private/admin",
            "https://other.example/x",
            "http://shop.example/insecure",
            "https://www.shop.example/contact",
            "https://shop.example:8443/x",
            "/moved",
          ]),
        },
        "https://shop.example/about": { body: html("About", "We have been cutting hair in Riyadh since 2010.") },
        "https://shop.example/private/menu": { body: html("Menu", "Haircut 50 SAR, beard trim 30 SAR, colour 120 SAR.") },
        "https://www.shop.example/contact": { body: html("Contact", "Call us any day between nine and nine.") },
        "https://shop.example/moved": { status: 302, headers: { location: "https://other.example/landing" } },
      },
    });
    const w = crawlWorld(net.deps);
    const src = website(w.db);
    const summary = await w.runner.run(src.id);
    expect(summary).toMatchObject({ failed: false, pagesRead: 4, pagesNew: 4 });

    const urls = net.urls();
    expect(pageUrls(urls).sort()).toEqual(
      ["https://shop.example/", "https://shop.example/about", "https://shop.example/moved", "https://shop.example/private/menu", "https://www.shop.example/contact"].sort(),
    );
    for (const never of ["/private/admin", "other.example", "cdn.other.example", "http://", ":8443"]) {
      expect({ never, hit: urls.some((u) => u.includes(never)) }).toEqual({ never, hit: false });
    }
    // Hosts other than the site were never even resolved.
    expect([...new Set(net.lookups)].sort()).toEqual(["shop.example", "www.shop.example"]);

    const pages = Object.fromEntries(w.db.knowledgePage.map((p) => [p.urlKey, p.state]));
    expect(pages).toEqual({
      "shop.example/": "synced",
      "shop.example/about": "synced",
      "shop.example/private/menu": "synced",
      "shop.example/contact": "synced", // www folded into one key
      "shop.example/private/admin": "blocked", // robots
      "shop.example/moved": "blocked", // redirect off the origin: not followed
    });
    expect(w.db.knowledgeChunk.every((c) => c.pageId)).toBe(true);
    expect(w.db.knowledgeSource[0]).toMatchObject({ status: "ready", consecutiveFailures: 0, syncStartedAt: null });
    // Politeness: at least a second between requests.
    expect(w.sleep).toHaveBeenCalled();
    for (const [ms] of w.sleep.mock.calls as unknown as [number][]) expect(ms).toBeGreaterThanOrEqual(MIN_REQUEST_GAP_MS);
    expect(w.publisher.schedule).toHaveBeenCalledWith(src.id);

    // Scope "path": only /blog/** is requested.
    const blog = fakeNet({
      dns: SHOP,
      pages: {
        "https://shop.example/robots.txt": notFound,
        "https://shop.example/sitemap.xml": notFound,
        "https://shop.example/blog": { body: html("Blog", "Our blog about hair care and styling tips.", ["/blog/a", "/about", "/blog-old", "/blog/b/c"]) },
        "https://shop.example/blog/a": { body: html("A", "First post about washing hair the right way.") },
        "https://shop.example/blog/b/c": { body: html("C", "Third post about colours for the summer season.") },
      },
    });
    const wb = crawlWorld(blog.deps);
    const bsrc = website(wb.db, { url: "https://shop.example/blog", scope: "path" });
    await wb.runner.run(bsrc.id);
    expect(pageUrls(blog.urls()).sort()).toEqual(["https://shop.example/blog", "https://shop.example/blog/a", "https://shop.example/blog/b/c"]);
  });

  it("robots unreachable fails the run without removing pages", async () => {
    const ok = fakeNet({
      dns: SHOP,
      pages: {
        "https://shop.example/robots.txt": notFound,
        "https://shop.example/sitemap.xml": notFound,
        "https://shop.example/": { body: html("Home", "Welcome to the shop, open every day of the week.") },
      },
    });
    const w = crawlWorld(ok.deps);
    const src = website(w.db);
    await w.runner.run(src.id);
    const before = JSON.stringify({ pages: w.db.knowledgePage, chunks: w.db.knowledgeChunk });
    expect(w.db.knowledgeChunk.length).toBeGreaterThan(0);

    for (const answer of [{ status: 503 }, { status: 500 }, { status: 302, headers: { location: "https://other.example/robots.txt" } }]) {
      const down = fakeNet({ dns: SHOP, pages: { "https://shop.example/robots.txt": answer } });
      const runner = crawlWorld(down.deps).runner;
      // Same database, a runner whose network answers robots.txt badly.
      Object.assign(runner, { prisma: w.prisma, perm: w.perm, notifications: w.notifications });
      const r = await runner.run(src.id);
      expect(r).toMatchObject({ failed: true, reason: "robots_unreachable", pagesRead: 0 });
      // Only robots.txt was asked for: no page was fetched or changed.
      expect(down.urls()).toEqual(["https://shop.example/robots.txt"]);
      expect(JSON.stringify({ pages: w.db.knowledgePage, chunks: w.db.knowledgeChunk })).toBe(before);
    }
    expect(w.db.knowledgeSource[0]).toMatchObject({ error: "knowledge.site_unreachable", consecutiveFailures: 3, status: "failed" });
  });

  it("crawler never fetches a private address on any redirect", async () => {
    let calls = 0;
    const net = fakeNet({
      // DNS rebinding attempt: public for robots, sitemap, home and /go; private on the redirect hop.
      dns: { "shop.example": () => (++calls <= 4 ? [PUBLIC_IP] : ["10.0.0.7"]) },
      pages: {
        "https://shop.example/robots.txt": notFound,
        "https://shop.example/sitemap.xml": notFound,
        "https://shop.example/": { body: html("Home", "Welcome to the shop, open every day of the week.", ["/go"]) },
        "https://shop.example/go": { status: 302, headers: { location: "/target" } },
        "https://shop.example/target": { body: html("T", "Should never be read because the address became private.") },
      },
    });
    const w = crawlWorld(net.deps);
    const src = website(w.db);
    await w.runner.run(src.id);
    for (const r of net.requests) expect(r.pinned?.address).toBe(PUBLIC_IP);
    expect(net.urls()).not.toContain("https://shop.example/target");
    expect(w.db.knowledgePage.find((p) => p.urlKey === "shop.example/go")?.state).toBe("blocked");
  });

  it("a run that reads nothing fails and keeps every page", async () => {
    let up = true;
    const net = fakeNet({
      dns: SHOP,
      pages: {
        "https://shop.example/robots.txt": notFound,
        "https://shop.example/sitemap.xml": notFound,
        "https://shop.example/": () => (up ? { body: html("Home", "Welcome to the shop, open every day of the week.", ["/a"]) } : { status: 500 }),
        "https://shop.example/a": () => (up ? { body: html("A", "Page A tells the story of the shop and its people.") } : { status: 500 }),
      },
    });
    const w = crawlWorld(net.deps);
    const src = website(w.db);
    await w.runner.run(src.id);
    const before = JSON.stringify({ pages: w.db.knowledgePage, chunks: w.db.knowledgeChunk });
    up = false;
    const r = await w.runner.run(src.id);
    expect(r).toMatchObject({ failed: true, reason: "no_pages", pagesRead: 0 });
    expect(JSON.stringify({ pages: w.db.knowledgePage, chunks: w.db.knowledgeChunk })).toBe(before);
    expect(w.db.knowledgeSource[0]).toMatchObject({ status: "ready", error: "knowledge.no_pages", consecutiveFailures: 1 });
  });

  it("needs_login keeps the last copy", async () => {
    let locked = false;
    const net = fakeNet({
      dns: SHOP,
      pages: {
        "https://shop.example/robots.txt": notFound,
        "https://shop.example/sitemap.xml": notFound,
        "https://shop.example/": { body: html("Home", "Welcome to the shop, open every day of the week.", ["/members"]) },
        "https://shop.example/members": () => (locked ? { status: 403 } : { body: html("Members", "Members get ten percent off every visit.") }),
      },
    });
    const w = crawlWorld(net.deps);
    const src = website(w.db);
    await w.runner.run(src.id);
    const page = () => w.db.knowledgePage.find((p) => p.urlKey === "shop.example/members")!;
    const chunks = () => w.db.knowledgeChunk.filter((c) => c.pageId === page().id).map((c) => c.text);
    const copy = chunks();
    expect(copy.join(" ")).toContain("ten percent");
    locked = true;
    await w.runner.run(src.id);
    expect(page()).toMatchObject({ state: "needs_login", httpStatus: 403 });
    expect(chunks()).toEqual(copy);
  });

  it("page removed only after two complete runs", async () => {
    let linkOld = true;
    const net = fakeNet({
      dns: SHOP,
      pages: {
        "https://shop.example/robots.txt": notFound,
        "https://shop.example/sitemap.xml": notFound,
        "https://shop.example/": () => ({ body: html("Home", "Welcome to the shop, open every day of the week.", linkOld ? ["/old"] : []) }),
        "https://shop.example/old": { body: html("Old", "An old offer page that will disappear from the site.") },
      },
    });
    const w = crawlWorld(net.deps);
    const src = website(w.db);
    await w.runner.run(src.id);
    const old = () => w.db.knowledgePage.find((p) => p.urlKey === "shop.example/old")!;
    const oldChunks = () => w.db.knowledgeChunk.filter((c) => c.pageId === old().id);
    expect(oldChunks().length).toBeGreaterThan(0);
    linkOld = false;
    await w.runner.run(src.id);
    expect(old()).toMatchObject({ state: "synced", missedRuns: 1 });
    expect(oldChunks().length).toBeGreaterThan(0);
    await w.runner.run(src.id);
    expect(old()).toMatchObject({ state: "removed", missedRuns: 2 });
    expect(old().removedAt).toBeInstanceOf(Date);
    expect(oldChunks()).toHaveLength(0);
  });

  it("unchanged page is skipped by content hash", async () => {
    const net = fakeNet({
      dns: SHOP,
      pages: {
        "https://shop.example/robots.txt": notFound,
        "https://shop.example/sitemap.xml": notFound,
        "https://shop.example/": { body: html("Home", "Welcome to the shop, open every day of the week.", ["/a"]) },
        "https://shop.example/a": { body: html("A", "Page A tells the story of the shop and its people.") },
      },
    });
    const w = crawlWorld(net.deps);
    const src = website(w.db);
    await w.runner.run(src.id);
    const ids = w.db.knowledgeChunk.map((c) => c.id).sort();
    const r = await w.runner.run(src.id);
    expect(r).toMatchObject({ pagesRead: 2, pagesSame: 2, pagesChanged: 0, pagesNew: 0 });
    expect(w.db.knowledgeChunk.map((c) => c.id).sort()).toEqual(ids);
  });

  it("page cap marks the rest capped and drops their chunks", async () => {
    const n = WEBSITE_PAGE_CAP + 10;
    const pages: Record<string, { body: string } | { status: number }> = {
      "https://shop.example/robots.txt": notFound,
      "https://shop.example/sitemap.xml": notFound,
      "https://shop.example/": { body: html("Home", "Welcome to the shop, open every day of the week.", Array.from({ length: n }, (_, i) => `/p${i}`)) },
    };
    for (let i = 0; i < n; i++) pages[`https://shop.example/p${i}`] = { body: html(`P${i}`, `Product page number ${i} with a long enough description.`) };
    const net = fakeNet({ dns: SHOP, pages });
    const w = crawlWorld(net.deps);
    const src = website(w.db);
    // A page synced earlier that is now past the cap.
    const lastId = "page_last";
    w.db.knowledgePage.push({ id: lastId, workspaceId: A, sourceId: src.id, url: `https://shop.example/p${n - 1}`, urlKey: `shop.example/p${n - 1}`, state: "synced", httpStatus: 200, title: "x", contentHash: "h", missedRuns: 0, lastSeenAt: null, lastReadAt: null, removedAt: null });
    w.db.knowledgeChunk.push({ id: "chunk_last", workspaceId: A, sourceId: src.id, pageId: lastId, ord: 0, heading: null, text: "stale text of a capped page", rowRef: null, validTo: null });
    await w.runner.run(src.id);
    expect(pageUrls(net.urls())).toHaveLength(WEBSITE_PAGE_CAP);
    const capped = w.db.knowledgePage.filter((p) => p.state === "capped");
    expect(capped).toHaveLength(n + 1 - WEBSITE_PAGE_CAP);
    expect(capped.map((p) => p.id)).toContain(lastId);
    expect(w.db.knowledgeChunk.some((c) => c.pageId === lastId)).toBe(false);
    expect(w.db.knowledgeChunk.some((c) => capped.some((p) => p.id === c.pageId))).toBe(false);
  });

  it("a 5 000-URL sitemap completes with a bounded sample of capped rows and a count", async () => {
    const n = 5000;
    const locs = Array.from({ length: n }, (_, i) => `<url><loc>https://shop.example/s${i}</loc></url>`).join("");
    const pages: Record<string, { body: string; headers?: Record<string, string> } | { status: number }> = {
      "https://shop.example/robots.txt": notFound,
      "https://shop.example/sitemap.xml": { headers: { "content-type": "application/xml" }, body: `<urlset>${locs}</urlset>` },
      "https://shop.example/": { body: html("Home", "Welcome to the shop, open every day of the week.") },
    };
    for (let i = 0; i < n; i++) pages[`https://shop.example/s${i}`] = { body: html(`S${i}`, `Sitemap page number ${i} with a long enough description.`) };
    const net = fakeNet({ dns: SHOP, pages });
    const w = crawlWorld(net.deps);
    const src = website(w.db);
    const summary = await w.runner.run(src.id);
    expect(summary).toMatchObject({ failed: false, pagesRead: WEBSITE_PAGE_CAP });
    expect(pageUrls(net.urls())).toHaveLength(WEBSITE_PAGE_CAP);
    // Only the sitemap's first SITEMAP_URL_CAP in-scope URLs are kept; the rest are counted as capped.
    expect(summary!.pagesCapped).toBe(SITEMAP_URL_CAP + 1 - WEBSITE_PAGE_CAP);
    const capped = w.db.knowledgePage.filter((p) => p.state === "capped");
    expect(capped.length).toBeLessThanOrEqual(CAPPED_ROW_SAMPLE);
    expect(w.db.knowledgePage).toHaveLength(WEBSITE_PAGE_CAP + capped.length);
    expect(w.db.knowledgeSource[0]).toMatchObject({ status: "ready", consecutiveFailures: 0, syncStartedAt: null });
    expect(w.db.knowledgeSource[0].lastRun).toMatchObject({ pagesCapped: SITEMAP_URL_CAP + 1 - WEBSITE_PAGE_CAP });
  });

  it("the apply transaction gets an explicit timeout and maxWait", async () => {
    const net = fakeNet({
      dns: SHOP,
      pages: {
        "https://shop.example/robots.txt": notFound,
        "https://shop.example/sitemap.xml": notFound,
        "https://shop.example/": { body: html("Home", "Welcome to the shop, open every day of the week.") },
      },
    });
    const w = crawlWorld(net.deps);
    const src = website(w.db);
    await w.runner.run(src.id);
    const calls = (w.prisma.$transaction as jest.Mock).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c[1]).toEqual({ timeout: APPLY_TX_TIMEOUT_MS, maxWait: APPLY_TX_MAX_WAIT_MS });
    expect(APPLY_TX_TIMEOUT_MS).toBeGreaterThan(5000);
  });

  it("every request to the site, robots.txt and sitemaps included, is at least the gap apart (fake clock)", async () => {
    const net = fakeNet({
      dns: SHOP,
      pages: {
        "https://shop.example/robots.txt": robots(["User-agent: *", "Allow: /", "Sitemap: https://shop.example/extra-sitemap.xml"].join("\n")),
        "https://shop.example/sitemap.xml": { headers: { "content-type": "application/xml" }, body: "<urlset><url><loc>https://shop.example/a</loc></url></urlset>" },
        "https://shop.example/extra-sitemap.xml": { headers: { "content-type": "application/xml" }, body: "<urlset><url><loc>https://shop.example/b</loc></url></urlset>" },
        "https://shop.example/": { body: html("Home", "Welcome to the shop, open every day of the week.", ["/c"]) },
        "https://shop.example/a": { body: html("A", "Page a has a long enough description of services.") },
        "https://shop.example/b": { body: html("B", "Page b has a long enough description of services.") },
        "https://shop.example/c": { body: html("C", "Page c has a long enough description of services.") },
      },
    });
    let clock = 0;
    const at: { url: string; t: number }[] = [];
    const deps: PageFetchDeps = {
      resolve: net.deps.resolve,
      request: async (req) => {
        at.push({ url: req.url.toString(), t: clock });
        clock += 5; // a fast server
        return net.deps.request(req);
      },
    };
    const w = crawlWorld(deps);
    const sleep = jest.fn(async (ms: number) => {
      clock += ms;
    });
    const runner = new CrawlRunner(w.prisma as any, w.perm, w.notifications as any, deps, sleep, w.publisher);
    const src = website(w.db);
    expect(await runner.run(src.id)).toMatchObject({ failed: false, pagesRead: 4 });
    expect(at.map((x) => x.url)).toEqual([
      "https://shop.example/robots.txt",
      "https://shop.example/sitemap.xml",
      "https://shop.example/extra-sitemap.xml",
      "https://shop.example/",
      "https://shop.example/a",
      "https://shop.example/b",
      "https://shop.example/c",
    ]);
    for (let i = 1; i < at.length; i++) expect({ url: at[i].url, gap: at[i].t - at[i - 1].t >= MIN_REQUEST_GAP_MS }).toEqual({ url: at[i].url, gap: true });
  });

  it("a page whose only text is its title (a JavaScript app shell) is an error with a keyed reason", async () => {
    const shell = `<html><head><title>Salon Booking App</title><script>window.app()</script></head><body><div id="root"></div><noscript>Enable JavaScript to use this site.</noscript></body></html>`;
    const net = fakeNet({
      dns: SHOP,
      pages: {
        "https://shop.example/robots.txt": notFound,
        "https://shop.example/sitemap.xml": notFound,
        "https://shop.example/": { body: html("Home", "Welcome to the shop, open every day of the week.", ["/app"]) },
        "https://shop.example/app": { body: shell },
      },
    });
    const w = crawlWorld(net.deps);
    const src = website(w.db);
    const summary = await w.runner.run(src.id);
    expect(summary).toMatchObject({ failed: false, pagesRead: 1, pagesNoText: 1 });
    const app = w.db.knowledgePage.find((p) => p.urlKey === "shop.example/app")!;
    expect(app.state).toBe("error");
    expect(w.db.knowledgeChunk.some((c) => c.pageId === app.id)).toBe(false);
    expect(w.db.knowledgeSource[0].lastRun).toMatchObject({ pagesNoText: 1, pageErrors: { "knowledge.page_no_text": 1 } });
    expect(PAGE_MIN_BODY_CHARS).toBeGreaterThan(0);

    // A site that is only an app shell fails with that reason, not a generic one.
    const only = fakeNet({
      dns: SHOP,
      pages: { "https://shop.example/robots.txt": notFound, "https://shop.example/sitemap.xml": notFound, "https://shop.example/": { body: shell } },
    });
    const w2 = crawlWorld(only.deps);
    const src2 = website(w2.db);
    expect(await w2.runner.run(src2.id)).toMatchObject({ failed: true, reason: "no_text" });
    expect(w2.db.knowledgeSource[0]).toMatchObject({ error: "knowledge.page_no_text" });
  });

  it("failed source emits knowledge_source_failed", async () => {
    let robotsDown = true;
    const net = fakeNet({
      dns: SHOP,
      pages: {
        "https://shop.example/robots.txt": () => (robotsDown ? { status: 503 } : notFound),
        "https://shop.example/sitemap.xml": notFound,
        "https://shop.example/": { body: html("Home", "Welcome to the shop, open every day of the week.") },
      },
    });
    const w = crawlWorld(net.deps);
    const src = website(w.db, { status: "ready", lastSyncAt: new Date() });
    const row = () => w.db.knowledgeSource.find((s) => s.id === src.id)!;

    await w.runner.run(src.id);
    await w.runner.run(src.id);
    expect(row()).toMatchObject({ consecutiveFailures: 2, status: "ready" });
    expect(row().nextSyncAt).toBeInstanceOf(Date);
    expect(w.notifications.notify).not.toHaveBeenCalled();

    await w.runner.run(src.id);
    expect(row()).toMatchObject({ consecutiveFailures: 3, status: "failed", nextSyncAt: null, error: "knowledge.site_unreachable" });
    expect(w.notifications.notify).toHaveBeenCalledTimes(1);
    const [ws, users, n] = (w.notifications.notify.mock.calls as unknown as [string, string[], { type: string; body: string }][])[0];
    expect(ws).toBe(A);
    expect([...users].sort()).toEqual(["uAdmin", "uKb", "uOwner"]);
    expect(n.type).toBe("knowledge_source_failed");
    expect(JSON.parse(n.body)).toMatchObject({ sourceId: src.id });

    // A successful refresh resets the count and the status.
    robotsDown = false;
    await w.runner.run(src.id);
    expect(row()).toMatchObject({ consecutiveFailures: 0, status: "ready", error: null });
    expect(row().nextSyncAt).toBeInstanceOf(Date);
    // A failure after recovery starts the count again (no notification).
    robotsDown = true;
    await w.runner.run(src.id);
    expect(row()).toMatchObject({ consecutiveFailures: 1, status: "ready" });
    expect(w.notifications.notify).toHaveBeenCalledTimes(1);
  });

  it("a fresh lease blocks a second run; a stale one is taken over", async () => {
    const net = fakeNet({ dns: SHOP, pages: {} });
    const w = crawlWorld(net.deps);
    const src = website(w.db, { syncStartedAt: new Date() });
    expect(await w.runner.run(src.id)).toBeNull();
    expect(net.requests).toHaveLength(0);
    expect(await w.runner.claim(src.id, new Date(Date.now() + 31 * 60 * 1000))).toBeInstanceOf(Date);
  });
});
