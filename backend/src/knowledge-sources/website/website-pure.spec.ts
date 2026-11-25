import { inScope, normalizeInputUrl, sameOrigin, siteOf, urlKey } from "./website-url";
import { ALLOW_ALL, parseRobots, robotsAllows } from "./robots";
import { isSitemapIndex, pageLinks, pageTitle, sitemapLocs } from "./discover";
import { nextRunAt } from "./schedule";

const u = (s: string) => new URL(s);

describe("website urls", () => {
  it("one key per page: scheme, www, fragment, tracking params and trailing slash folded", () => {
    expect(urlKey(u("https://www.Shop.example/menu/?utm_source=x&b=2&a=1#top"))).toBe("shop.example/menu?a=1&b=2");
    expect(urlKey(u("https://shop.example/menu?fbclid=1"))).toBe("shop.example/menu");
    expect(urlKey(u("https://shop.example"))).toBe("shop.example/");
  });

  it("same origin is https, default port, www folded; scope path stays under the start path", () => {
    const site = siteOf(u("https://www.shop.example/"), "site");
    expect(sameOrigin(site, u("https://shop.example/a"))).toBe(true);
    expect(sameOrigin(site, u("https://www.shop.example/a"))).toBe(true);
    for (const bad of ["http://shop.example/a", "https://shop.example:8443/a", "https://other.example/", "https://cdn.shop.example/a", "https://u:p@shop.example/"]) {
      expect({ bad, ok: sameOrigin(site, u(bad)) }).toEqual({ bad, ok: false });
    }
    const blog = siteOf(u("https://shop.example/blog"), "path");
    expect(inScope(blog, u("https://shop.example/blog"))).toBe(true);
    expect(inScope(blog, u("https://shop.example/blog/a/b"))).toBe(true);
    expect(inScope(blog, u("https://shop.example/blog-old"))).toBe(false);
    expect(inScope(blog, u("https://shop.example/about"))).toBe(false);
  });

  it("member input: bare hosts get https, http is upgraded, other schemes and ports are refused", () => {
    expect(normalizeInputUrl("shop.example/menu")).toMatchObject({ wasHttp: false });
    expect(normalizeInputUrl("shop.example/menu")!.url.toString()).toBe("https://shop.example/menu");
    expect(normalizeInputUrl("http://shop.example/")).toMatchObject({ wasHttp: true });
    expect(normalizeInputUrl("http://shop.example/")!.url.protocol).toBe("https:");
    for (const bad of ["", "ftp://shop.example", "javascript:alert(1)", "https://shop.example:8443/", "https://u:p@shop.example", "not a url"]) {
      expect({ bad, r: normalizeInputUrl(bad) }).toEqual({ bad, r: null });
    }
  });
});

describe("robots.txt", () => {
  it("our group wins over *, longest match wins, Allow wins a tie, wildcards and $ work", () => {
    const r = parseRobots(
      ["User-agent: *", "Disallow: /", "", "User-agent: KewyKnowledgeBot", "Disallow: /private", "Allow: /private/menu", "Disallow: /*.pdf$", "Crawl-delay: 4", "Sitemap: https://shop.example/s.xml"].join("\n"),
    );
    expect(robotsAllows(r, "/")).toBe(true); // our group has no rule for /
    expect(robotsAllows(r, "/private/admin")).toBe(false);
    expect(robotsAllows(r, "/private/menu")).toBe(true);
    expect(robotsAllows(r, "/files/a.pdf")).toBe(false);
    expect(robotsAllows(r, "/files/a.pdf?x=1")).toBe(true);
    expect(r.crawlDelaySeconds).toBe(4);
    expect(r.sitemaps).toEqual(["https://shop.example/s.xml"]);
    const tie = parseRobots("User-agent: *\nDisallow: /a\nAllow: /a");
    expect(robotsAllows(tie, "/a/b")).toBe(true);
    const star = parseRobots("User-agent: *\nDisallow: /private\n\nUser-agent: OtherBot\nDisallow: /");
    expect(robotsAllows(star, "/private/x")).toBe(false);
    expect(robotsAllows(star, "/public")).toBe(true);
    expect(robotsAllows(ALLOW_ALL, "/anything")).toBe(true);
    expect(robotsAllows(parseRobots("User-agent: *\nDisallow:"), "/x")).toBe(true);
  });
});

describe("discovery", () => {
  it("sitemap locs, sitemap index, links and titles", () => {
    expect(sitemapLocs("<urlset><url><loc> https://a.example/x?a=1&amp;b=2 </loc></url><url><loc>https://a.example/y</loc></url></urlset>")).toEqual([
      "https://a.example/x?a=1&b=2",
      "https://a.example/y",
    ]);
    expect(isSitemapIndex("<?xml?><sitemapindex><sitemap><loc>x</loc></sitemap></sitemapindex>")).toBe(true);
    const links = pageLinks(
      '<a href="/a">A</a><abbr>x</abbr><a class="x" href=\'https://b.example/\'>B</a><a href=#top>T</a><a href="mailto:x@y">M</a><a href="tel:1">T</a><area href="/no">',
      u("https://shop.example/dir/"),
    );
    expect(links.map((l) => l.toString())).toEqual(["https://shop.example/a", "https://b.example/"]);
    expect(pageTitle("<head><title> Salon  Menu </title></head>")).toBe("Salon Menu");
    // Linear on hostile input: an unclosed tag at scale returns quickly.
    const big = "<a ".repeat(200_000);
    const t0 = Date.now();
    expect(pageLinks(big, u("https://shop.example/"))).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe("schedule", () => {
  it("schedule next run per daily, weekly, monthly and manual", () => {
    const from = new Date("2026-01-31T10:00:00.000Z");
    expect(nextRunAt("daily", from)!.toISOString()).toBe("2026-02-01T10:00:00.000Z");
    expect(nextRunAt("weekly", from)!.toISOString()).toBe("2026-02-07T10:00:00.000Z");
    expect(nextRunAt("monthly", from)!.toISOString()).toBe("2026-02-28T10:00:00.000Z"); // clamped
    expect(nextRunAt("monthly", new Date("2028-01-31T00:00:00.000Z"))!.toISOString()).toBe("2028-02-29T00:00:00.000Z"); // leap year
    expect(nextRunAt("monthly", new Date("2026-12-15T08:30:00.000Z"))!.toISOString()).toBe("2027-01-15T08:30:00.000Z");
    expect(nextRunAt("manual", from)).toBeNull();
    expect(nextRunAt(null, from)).toBeNull();
  });
});
