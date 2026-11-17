/* eslint-disable @typescript-eslint/no-explicit-any */
import { WebsitesService } from "./websites.service";
import { fakeNet, html, PUBLIC_IP, website, A, B } from "./crawl-test-world";
import { knowledgeWorld, failure } from "../knowledge-test-world";
import { REFRESH_COOLDOWN_MS, WEBSITE_MAX_SOURCES, WEBSITE_STALE_MS } from "../knowledge-constants";
import { isSyncing } from "../knowledge-sources.service";

function setup(net = fakeNet({ dns: {}, pages: {} })) {
  const w = knowledgeWorld();
  const scheduler = { kick: jest.fn(() => true) };
  const svc = new WebsitesService(w.prisma as any, w.svc, scheduler as any, net.deps);
  return { ...w, scheduler, websites: svc, net };
}

const shopNet = () =>
  fakeNet({
    dns: { "shop.example": [PUBLIC_IP], "www.shop.example": [PUBLIC_IP] },
    pages: {
      "https://shop.example/": { body: html("Shop", "Welcome to the shop.") },
      "https://www.shop.example/": { body: html("Shop", "Welcome to the shop.") },
      "https://www.shop.example/robots.txt": { status: 404 },
      "https://www.shop.example/sitemap.xml": { status: 404 },
      "https://shop.example/robots.txt": { headers: { "content-type": "text/plain" }, body: "User-agent: *\nDisallow: /private" },
      "https://shop.example/sitemap.xml": { headers: { "content-type": "application/xml" }, body: "<urlset><url><loc>https://shop.example/a</loc></url><url><loc>https://shop.example/b</loc></url></urlset>" },
      "https://shop.example/private": { body: html("P", "private") },
    },
  });

describe("WebsitesService", () => {
  it("website check refuses local, ip and non-https addresses", async () => {
    const net = fakeNet({
      dns: { "intranet.example": ["10.0.0.4"], "shop.example": [PUBLIC_IP], "nohttps.example": [PUBLIC_IP] },
      pages: {
        "https://shop.example/": { body: html("Shop", "Welcome") },
        "https://shop.example/robots.txt": { status: 404 },
        "https://shop.example/sitemap.xml": { status: 404 },
        "https://nohttps.example/": { status: 503 },
      },
    });
    const { websites } = setup(net);
    const key = async (url: string) => (await failure(websites.check(url))).body.message;
    for (const blocked of ["https://localhost/", "https://127.0.0.1/", "https://10.0.0.5/", "https://[::1]/", "https://8.8.8.8/", "https://printer.local/", "https://intranet.example/", "https://router/"]) {
      expect({ blocked, k: await key(blocked) }).toEqual({ blocked, k: "knowledge.url_blocked" });
    }
    expect(await key("http://nohttps.example/")).toBe("knowledge.not_https");
    expect(await key("https://nohttps.example/")).toBe("knowledge.not_https");
    for (const bad of ["ftp://shop.example/", "javascript:alert(1)", "https://shop.example:8443/", ""]) {
      expect({ bad, k: await key(bad) }).toEqual({ bad, k: "knowledge.url_invalid" });
    }
    // An http address that answers over https is upgraded.
    await expect(websites.check("http://shop.example/")).resolves.toEqual({
      ok: true,
      normalizedUrl: "https://shop.example/",
      host: "shop.example",
      robotsAllowed: true,
      sitemapPages: null,
    });
    // No request ever went to a refused address.
    for (const r of net.requests) expect(r.url.hostname).not.toMatch(/localhost|127\.0\.0\.1|10\.0\.0|intranet/);
  });

  it("check reports robots and the sitemap size", async () => {
    const { websites } = setup(shopNet());
    await expect(websites.check("shop.example")).resolves.toMatchObject({ robotsAllowed: true, sitemapPages: 2 });
    await expect(websites.check("https://shop.example/private")).resolves.toMatchObject({ robotsAllowed: false });
  });

  it("SP-20: onboarding caps the first run", async () => {
    const { websites, scheduler } = setup(shopNet());
    const capped = await websites.create(A, "uOwner", { url: "https://shop.example/" }, { firstRunPageCap: 20 });
    expect(scheduler.kick).toHaveBeenCalledWith(capped.id, A, { pageCap: 20 });
  });

  it("create kicks the first run; limit and duplicates are refused", async () => {
    const { websites, scheduler, db } = setup(shopNet());
    const dto = await websites.create(A, "uOwner", { url: "https://www.shop.example/", schedule: "daily" });
    expect(dto).toMatchObject({ kind: "website", status: "queued", schedule: "daily", scope: "site", url: "https://www.shop.example/" });
    expect(scheduler.kick).toHaveBeenCalledWith(dto.id, A, {});
    expect((await failure(websites.create(A, "uOwner", { url: "https://shop.example" }))).body.message).toBe("knowledge.website_exists");
    // Another scope of the same site is a different source.
    await expect(websites.create(A, "uOwner", { url: "https://shop.example/private", scope: "path" })).resolves.toMatchObject({ scope: "path" });
    for (let i = db.knowledgeSource.length; i < WEBSITE_MAX_SOURCES; i++) website(db, { url: `https://shop.example/x${i}`, scope: "path" });
    expect(await failure(websites.create(A, "uOwner", { url: "https://shop.example/" , scope: "path" }))).toMatchObject({
      status: 400,
      body: { message: "knowledge.website_limit", limit: WEBSITE_MAX_SOURCES },
    });
  });

  it("refresh cooldown and syncing are 409", async () => {
    const { websites, db, scheduler } = setup();
    const src: any = website(db, { status: "ready" });
    const now = new Date("2026-11-17T10:00:00Z");
    await expect(websites.refresh(A, src.id, now)).resolves.toMatchObject({ id: src.id });
    expect(scheduler.kick).toHaveBeenCalledWith(src.id, A);
    // Within the hour: cooldown with the seconds left.
    const later = new Date(now.getTime() + 10 * 60 * 1000);
    expect(await failure(websites.refresh(A, src.id, later))).toEqual({
      status: 409,
      body: { statusCode: 409, message: "knowledge.cooldown", retryAfterSeconds: (REFRESH_COOLDOWN_MS - 10 * 60 * 1000) / 1000 },
    });
    // A run in progress: syncing.
    src.syncStartedAt = later;
    const afterCooldown = new Date(now.getTime() + REFRESH_COOLDOWN_MS + 1000);
    src.syncStartedAt = new Date(afterCooldown.getTime() - 60_000);
    expect(await failure(websites.refresh(A, src.id, afterCooldown))).toEqual({ status: 409, body: { statusCode: 409, message: "knowledge.syncing" } });
    // A failed source may be refreshed.
    src.syncStartedAt = null;
    src.status = "failed";
    await expect(websites.refresh(A, src.id, afterCooldown)).resolves.toMatchObject({ status: "failed" });
    // Foreign or unknown id: 404.
    const other = website(db, { workspaceId: B });
    for (const id of [other.id, "nope"]) expect((await failure(websites.refresh(A, id, afterCooldown))).status).toBe(404);
  });

  it("patch pauses, resumes and reschedules with the version check", async () => {
    const { websites, db } = setup();
    const src = website(db, { status: "ready", lastSyncAt: new Date(), schedule: "weekly", version: 0 });
    await expect(websites.patch(A, src.id, { paused: true, version: 0 })).resolves.toMatchObject({ status: "paused", nextSyncAt: null, version: 1 });
    expect((await failure(websites.patch(A, src.id, { paused: false, version: 0 }))).body.message).toBe("knowledge.version_conflict");
    const resumed = await websites.patch(A, src.id, { paused: false, schedule: "monthly", version: 1 });
    expect(resumed).toMatchObject({ status: "ready", schedule: "monthly" });
    expect(resumed.nextSyncAt).toBeInstanceOf(Date);
    const manual = await websites.patch(A, src.id, { schedule: "manual", version: 2 });
    expect(manual.nextSyncAt).toBeNull();
  });
});

describe("knowledge source DTO: syncing", () => {
  it("a live crawl reads true; an idle source and a stale lease read false", async () => {
    const w = knowledgeWorld();
    const live = website(w.db, { status: "ready", syncStartedAt: new Date(Date.now() - 60_000) });
    const idle = website(w.db, { status: "ready", syncStartedAt: null });
    const stale = website(w.db, { status: "ready", syncStartedAt: new Date(Date.now() - WEBSITE_STALE_MS - 60_000) });
    expect((await w.svc.get(A, live.id)).syncing).toBe(true);
    expect((await w.svc.get(A, idle.id)).syncing).toBe(false);
    expect((await w.svc.get(A, stale.id)).syncing).toBe(false);
    const listed = Object.fromEntries((await w.svc.list(A)).items.map((i) => [i.id, i.syncing]));
    expect(listed).toEqual({ [live.id]: true, [idle.id]: false, [stale.id]: false });
    // The same rule as the crawler: exactly at the limit it is still live, past it a new run may claim it.
    const at = new Date(Date.now() - WEBSITE_STALE_MS);
    expect(isSyncing({ kind: "website", syncStartedAt: at }, new Date(at.getTime() + WEBSITE_STALE_MS))).toBe(true);
    expect(isSyncing({ kind: "website", syncStartedAt: at }, new Date(at.getTime() + WEBSITE_STALE_MS + 1))).toBe(false);
  });

  it("file sources keep their status semantics and never read as syncing", async () => {
    const w = knowledgeWorld();
    const base = { workspaceId: A, kind: "file", error: null, title: "Menu.pdf", order: 0, consecutiveFailures: 0, itemCount: 0, publishState: "none", legacyRef: null, version: 0, mediaId: null, createdAt: new Date(), updatedAt: new Date() };
    w.db.knowledgeSource.push({ ...base, id: "f_proc", status: "processing", syncStartedAt: new Date(), leaseUntil: new Date(Date.now() + 60_000) });
    w.db.knowledgeSource.push({ ...base, id: "f_queued", status: "queued", syncStartedAt: null });
    expect(await w.svc.get(A, "f_proc")).toMatchObject({ status: "processing", syncing: false });
    expect(await w.svc.get(A, "f_queued")).toMatchObject({ status: "queued", syncing: false });
  });
});
