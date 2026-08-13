# Tier 1B: Social Analytics Overview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Social performance" section on the Analytics screen showing per-platform follower growth and window impressions/reach/engagement from Zernio, behind one backend endpoint that degrades gracefully when Zernio can't serve analytics.

**Architecture:** Spike-first (Zernio docs have been wrong three times): Task 1 live-verifies the analytics/follower-stats shapes and the "analytics add-on" 402 question against the real account. Task 2 wraps the verified endpoints in `ZernioClient` + a `ZernioService.analyticsOverview` mapper whose OUTPUT contract is fixed (tests pin it) while the input mapping adapts to spike findings; all Zernio failure modes collapse into `{available:false, reason}` at HTTP 200. Task 3 renders the section on the existing Analytics screen off the page's 7/30 toggle. Task 4 verifies end-to-end.

**Tech Stack:** NestJS 10 + jest/ts-jest (`backend/`, specs at `src/**/*.spec.ts`); React 18 with the repo's `useFetch` hooks and `Spark` chart primitive; no frontend test runner (typecheck + verify skill).

**Spec:** `docs/superpowers/specs/2026-08-13-social-analytics-overview-design.md`

## Global Constraints

- **Bilingual copy:** every user-facing string via `tx("English", "العربية")` with real Arabic.
- **Selective commits:** never `git add -A`; each commit adds only its task's files. Trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **Branch:** `feat/whatsapp-ai-mvp`. **No new dependencies.** **No schema changes.**
- **Honesty rule:** metrics a platform doesn't provide are `null` → rendered "—"; never a fabricated 0.
- **Degradation rule:** Zernio 402 → `{available:false, reason:"plan"}`; other upstream failure → `reason:"upstream"`; no profile → `reason:"not_connected"`; all HTTP 200 with a warn log. The screen never errors because the vendor did.
- **Zernio safety:** the spike and E2E are READ-ONLY against the live account (GET endpoints only; no posts, no writes).
- **Workspace scoping:** resolve `zernioProfileId` via `ZernioService.getProfileId` (existing pattern).
- **Backend tests:** from `backend/`: `npx jest <path>`; full suite `npm test`. **Frontend:** root `npm run typecheck`.
- **Backend dev server on :4100** runs supervisor-restarted `dist/main` — after rebuilds, `npx kill-port 4100` (direct process kills are blocked here) and the supervisor restarts it fresh.

---

### Task 1: Live spike — analytics shapes and the 402 question

No production code. Verdicts feed Task 2's mapping. Read-only GETs with `ZERNIO_API_KEY` from `backend/.env` against `https://zernio.com/api/v1`. The profileId is in the spike doc from Tier 1A (`docs/superpowers/plans/2026-08-13-spike-findings.md`: `6a5e2408d93a61a68d12624b`) — re-verify it via `GET /accounts?profileId=` before use.

**Files:**
- Create: `docs/superpowers/plans/2026-08-13-analytics-spike-findings.md`

**Interfaces:**
- Produces verdicts: `ANALYTICS_SHAPE: aggregate|per-post|both`, exact param names (date range, platform filter), exact metric field names per platform, `FOLLOWER_STATS: <path + shape or NOT AVAILABLE>`, `PLAN_GATED: yes|no (which endpoints)`.

- [ ] **Step 1: Probe GET /analytics for a date-ranged window**

```bash
curl -s "https://zernio.com/api/v1/analytics?profileId=<PROFILE>&fromDate=<NOW-30D YYYY-MM-DD>&toDate=<NOW YYYY-MM-DD>&limit=100" -H "Authorization: Bearer $ZERNIO_API_KEY"
```

Record: HTTP status (402? watch for it), whether the response contains aggregate totals anywhere (summary/totals object) or only a `posts` array of per-post rows; the exact metric keys present per row for facebook vs instagram posts (candidates from docs: impressions, reach, likes, comments, shares, saves, clicks, views, engagement/engagementRate); whether `platform=` filters. Try also `sortBy=impressions` (docs mention it) and note whether unknown params error or are ignored.

- [ ] **Step 2: Probe follower stats**

```bash
curl -s "https://zernio.com/api/v1/accounts/follower-stats?profileId=<PROFILE>&granularity=daily" -H "Authorization: Bearer $ZERNIO_API_KEY"
```

If 404, try variants the docs sitemap suggests (`/accounts/follower-stats` without granularity; check `https://docs.zernio.com/llms.txt` for the exact page, e.g. "get-follower-stats", and fetch that page for the documented path/params). Record: exact path, params, response shape (per-account series? date format? count field name?), how much history exists for this young account, and the HTTP status (402?).

- [ ] **Step 3: Record the 402 verdict**

`PLAN_GATED: yes|no` per endpoint, with the raw error body if gated. If gated, note the exact status/error string so Task 2 can match it precisely.

- [ ] **Step 4: Write + commit findings**

Write `docs/superpowers/plans/2026-08-13-analytics-spike-findings.md` with all verdicts + raw request/response excerpts (redact nothing but the API key).

```bash
git add docs/superpowers/plans/2026-08-13-analytics-spike-findings.md
git commit -m "docs(spike): verify Zernio analytics + follower-stats shapes and plan gating

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Backend — overview endpoint with fixed contract

**Files:**
- Modify: `backend/src/integrations/zernio.client.ts` (two methods after `updatePost`)
- Modify: `backend/src/integrations/zernio.service.ts` (add `analyticsOverview` after `reschedulePost`)
- Modify: `backend/src/social/social.service.ts`, `backend/src/social/social.controller.ts`
- Test: `backend/src/integrations/zernio.service.analytics.spec.ts` (new)

**Interfaces:**
- Consumes: Task 1 verdicts (paths/params/field names; PLAN_GATED).
- Produces (used by Task 3): `GET /social/analytics/overview?days=7|30` →

```ts
type OverviewMetric = number | null;
interface SocialOverview {
  available: boolean;
  reason?: "not_connected" | "plan" | "upstream";
  windowDays?: 7 | 30;
  platforms?: Array<{
    platform: string;
    followers: { current: number; delta: number; series: { date: string; count: number }[] };
    impressions: OverviewMetric; reach: OverviewMetric; engagement: OverviewMetric;
    likes: OverviewMetric; comments: OverviewMetric; shares: OverviewMetric;
  }>;
}
```

`followers.delta = series[last].count - series[first].count`; series daily, oldest-first, clipped to the window. If follower stats turned out NOT AVAILABLE in the spike, `followers` becomes `{ current: 0, delta: 0, series: [] }` ONLY when the platform truly reports nothing — prefer omitting the platform card entirely if it has neither posts nor follower data.

- [ ] **Step 1: Write the failing tests** (`zernio.service.analytics.spec.ts` — construct `ZernioService` directly with mocks, same pattern as `zernio.service.scheduled.spec.ts`: constructor `(prisma, realtime, media, client)`):

```ts
import { ZernioService } from "./zernio.service";
import { HttpException } from "@nestjs/common";

describe("ZernioService.analyticsOverview", () => {
  let prisma: { workspace: { findUnique: jest.Mock } };
  let client: {
    getAnalytics: jest.Mock;
    getFollowerStats: jest.Mock;
  };
  let svc: ZernioService;

  beforeEach(() => {
    prisma = {
      workspace: { findUnique: jest.fn().mockResolvedValue({ zernioProfileId: "prof1" }) },
    };
    client = {
      getAnalytics: jest.fn(),
      getFollowerStats: jest.fn(),
    };
    svc = new ZernioService(
      prisma as never,
      { emitToWorkspace: jest.fn() } as never,
      {} as never,
      client as never,
    );
  });

  it("returns not_connected without a profile", async () => {
    prisma.workspace.findUnique.mockResolvedValue({ zernioProfileId: null });
    const res = await svc.analyticsOverview("ws1", 7);
    expect(res).toEqual({ available: false, reason: "not_connected" });
    expect(client.getAnalytics).not.toHaveBeenCalled();
  });

  it("maps per-platform metrics and follower series (fixed output contract)", async () => {
    // ADAPT the mock INPUT shapes to the spike findings; the OUTPUT assertions
    // below are the contract and must not change.
    client.getAnalytics.mockResolvedValue([
      { platform: "facebook", analytics: { impressions: 100, likes: 5, comments: 2, shares: 1 } },
      { platform: "facebook", analytics: { impressions: 50, likes: 3, comments: 0, shares: 0 } },
      { platform: "instagram", analytics: { likes: 7, comments: 4 } }, // no impressions on IG rows
    ]);
    client.getFollowerStats.mockResolvedValue([
      { platform: "facebook", series: [{ date: "2026-08-06", count: 100 }, { date: "2026-08-13", count: 110 }] },
      { platform: "instagram", series: [{ date: "2026-08-06", count: 200 }, { date: "2026-08-13", count: 195 }] },
    ]);
    const res = await svc.analyticsOverview("ws1", 7);
    expect(res.available).toBe(true);
    expect(res.windowDays).toBe(7);
    const fb = res.platforms!.find((p) => p.platform === "facebook")!;
    expect(fb.impressions).toBe(150);
    expect(fb.likes).toBe(8);
    expect(fb.followers).toEqual({
      current: 110,
      delta: 10,
      series: [{ date: "2026-08-06", count: 100 }, { date: "2026-08-13", count: 110 }],
    });
    const ig = res.platforms!.find((p) => p.platform === "instagram")!;
    expect(ig.impressions).toBeNull(); // absent metric -> null, never 0
    expect(ig.likes).toBe(11);
    expect(ig.followers.delta).toBe(-5);
  });

  it("collapses a 402 into reason:plan", async () => {
    client.getAnalytics.mockRejectedValue(new HttpException("Analytics add-on required", 402));
    const res = await svc.analyticsOverview("ws1", 30);
    expect(res).toEqual({ available: false, reason: "plan" });
  });

  it("collapses other upstream failures into reason:upstream", async () => {
    client.getAnalytics.mockRejectedValue(new HttpException("Zernio API unreachable", 502));
    const res = await svc.analyticsOverview("ws1", 7);
    expect(res).toEqual({ available: false, reason: "upstream" });
  });
});
```

(If the spike proved PLAN_GATED=yes for real, the 402 test reflects the *actual* error your client throws — `ZernioClient.request` surfaces 4xx statuses as-is, so `HttpException(msg, 402)` is what arrives.)

- [ ] **Step 2: Run to verify failure**

`npx jest src/integrations/zernio.service.analytics.spec.ts` → FAIL (`analyticsOverview is not a function`).

- [ ] **Step 3: Client methods** (`zernio.client.ts`, after `updatePost` — ADAPT paths/params/return parsing to the spike findings; the signatures stay):

```ts
  /** Per-post analytics rows for a date window (spike-verified 2026-08-13). */
  async getAnalytics(
    profileId: string,
    opts: { fromDate: string; toDate: string },
  ): Promise<ZernioAnalyticsRow[]> {
    const res = await this.request<{ posts?: ZernioAnalyticsRow[]; data?: ZernioAnalyticsRow[] }>(
      "GET",
      "/analytics",
      { query: { profileId, fromDate: opts.fromDate, toDate: opts.toDate, limit: "100" } },
    );
    return res.posts ?? res.data ?? [];
  }

  /** Follower history per account (spike-verified path/shape). */
  async getFollowerStats(profileId: string): Promise<ZernioFollowerStatsRow[]> {
    const res = await this.request<{ data?: ZernioFollowerStatsRow[]; accounts?: ZernioFollowerStatsRow[] }>(
      "GET",
      "/accounts/follower-stats",
      { query: { profileId } },
    );
    return res.data ?? res.accounts ?? [];
  }
```

Add the two row interfaces next to `ZernioPost`, with the field names the spike found (defensive optionals, same style as `ZernioPost`):

```ts
export interface ZernioAnalyticsRow {
  platform?: string;
  platforms?: Array<{ platform?: string } | string>;
  analytics?: {
    impressions?: number; reach?: number; likes?: number; comments?: number;
    shares?: number; engagement?: number; views?: number;
  };
}

export interface ZernioFollowerStatsRow {
  platform?: string;
  accountId?: string;
  series?: Array<{ date?: string; count?: number; followers?: number }>;
  history?: Array<{ date?: string; count?: number; followers?: number }>;
}
```

- [ ] **Step 4: Service mapping** (`zernio.service.ts`, after `reschedulePost`):

```ts
  async analyticsOverview(workspaceId: string, days: 7 | 30) {
    const profileId = await this.getProfileId(workspaceId);
    if (!profileId) return { available: false as const, reason: "not_connected" as const };
    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    try {
      const [rows, followerRows] = await Promise.all([
        this.client.getAnalytics(profileId, { fromDate: iso(from), toDate: iso(to) }),
        this.client.getFollowerStats(profileId),
      ]);
      // Sum per-post metrics per platform. A metric key that appears on NO row
      // for a platform stays null (the platform doesn't provide it); a key that
      // appears on some rows sums the ones present.
      const METRICS = ["impressions", "reach", "engagement", "likes", "comments", "shares"] as const;
      const byPlatform = new Map<string, Record<string, number | null>>();
      for (const row of rows) {
        const platform =
          row.platform ??
          (Array.isArray(row.platforms)
            ? row.platforms.map((p) => (typeof p === "string" ? p : p.platform ?? "")).find(Boolean)
            : undefined);
        if (!platform) continue;
        const acc =
          byPlatform.get(platform) ??
          Object.fromEntries(METRICS.map((m) => [m, null as number | null]));
        for (const m of METRICS) {
          const v = row.analytics?.[m];
          if (typeof v === "number") acc[m] = (acc[m] ?? 0) + v;
        }
        byPlatform.set(platform, acc);
      }
      const followerByPlatform = new Map<string, { current: number; delta: number; series: { date: string; count: number }[] }>();
      for (const fr of followerRows) {
        if (!fr.platform) continue;
        const raw = (fr.series ?? fr.history ?? [])
          .map((p) => ({ date: p.date ?? "", count: p.count ?? p.followers ?? 0 }))
          .filter((p) => p.date && p.date >= iso(from))
          .sort((a, b) => (a.date < b.date ? -1 : 1));
        if (!raw.length) continue;
        followerByPlatform.set(fr.platform, {
          current: raw[raw.length - 1].count,
          delta: raw[raw.length - 1].count - raw[0].count,
          series: raw,
        });
      }
      const names = new Set([...byPlatform.keys(), ...followerByPlatform.keys()]);
      const platforms = [...names].map((platform) => ({
        platform,
        followers:
          followerByPlatform.get(platform) ?? { current: 0, delta: 0, series: [] },
        ...(byPlatform.get(platform) ??
          Object.fromEntries(METRICS.map((m) => [m, null as number | null]))),
      }));
      return { available: true as const, windowDays: days, platforms };
    } catch (e) {
      const status = (e as { getStatus?: () => number }).getStatus?.() ?? 0;
      const reason = status === 402 ? ("plan" as const) : ("upstream" as const);
      this.log.warn(`analyticsOverview ws=${workspaceId} unavailable (${reason}): ${(e as Error).message}`);
      return { available: false as const, reason };
    }
  }
```

- [ ] **Step 5: Route** — `social.service.ts`:

```ts
  analyticsOverview(workspaceId: string, days: 7 | 30) {
    return this.zernio.analyticsOverview(workspaceId, days);
  }
```

`social.controller.ts` (import `Get`, `Query` already present from Tier 0 routes):

```ts
  @Get("analytics/overview")
  analyticsOverview(
    @CurrentWorkspace() workspaceId: string,
    @Query("days") daysQ?: string,
  ) {
    return this.svc.analyticsOverview(workspaceId, daysQ === "30" ? 30 : 7);
  }
```

- [ ] **Step 6: Run tests + build; live smoke**

`npx jest src/integrations/zernio.service.analytics.spec.ts` → 4/4 PASS; `npm test` full suite green; `npm run build` clean. Rebuild + `npx kill-port 4100`, then curl `GET /api/social/analytics/overview?days=30` with a login token — record the real payload in your report (this is the first live use of the mapping).

- [ ] **Step 7: Commit**

```bash
git add backend/src/integrations backend/src/social
git commit -m "feat(social): Zernio analytics overview endpoint with graceful degradation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Frontend — Social performance section

**Files:**
- Modify: `src/screens/Analytics.tsx` (imports :1-7, interfaces after :20, section after the message-volume card)

**Interfaces:**
- Consumes: `GET /social/analytics/overview?days=` (Task 2 `SocialOverview` shape); `Spark({ values, w?, h?, color? })` from `@/components/charts`.

- [ ] **Step 1: Wire the fetch + types**

Add to the imports: `Spark` (extend the existing `@/components/charts` import). Add interfaces after `PipelineSummary`:

```ts
interface SocialPlatformOverview {
  platform: string;
  followers: { current: number; delta: number; series: { date: string; count: number }[] };
  impressions: number | null; reach: number | null; engagement: number | null;
  likes: number | null; comments: number | null; shares: number | null;
}
interface SocialOverview {
  available: boolean;
  reason?: "not_connected" | "plan" | "upstream";
  windowDays?: 7 | 30;
  platforms?: SocialPlatformOverview[];
}
```

In `AnalyticsImpl` add: `const socialQ = useFetch<SocialOverview>(`/social/analytics/overview?days=${days}`);` and `const so = socialQ.data;`.

- [ ] **Step 2: Render the section** — insert this card AFTER the message-volume card's closing `</div>` and BEFORE the two-column grid:

```tsx
        {so && so.available === false && (so.reason === "plan" || so.reason === "upstream") && (
          <div className="card">
            <div className="card-h"><h3>{tx("Social performance", "الأداء الاجتماعي")}</h3></div>
            <div style={{ padding: 18, fontSize: 13, color: "var(--ink-3)" }}>
              {so.reason === "plan"
                ? tx(
                    "Social analytics isn't included in the current Zernio plan.",
                    "تحليلات التواصل غير متضمنة في خطة Zernio الحالية.",
                  )
                : tx(
                    "Social analytics is temporarily unavailable.",
                    "تحليلات التواصل غير متاحة مؤقتًا.",
                  )}
            </div>
          </div>
        )}
        {so?.available && (so.platforms?.length ?? 0) > 0 && (
          <div className="card">
            <div className="card-h">
              <h3>{tx("Social performance", "الأداء الاجتماعي")}</h3>
              <span className="sub">
                {days === 7 ? tx("Last 7 days", "آخر ٧ أيام") : tx("Last 30 days", "آخر ٣٠ يوم")}
              </span>
            </div>
            <div style={{ padding: 18, display: "grid", gap: 14 }}>
              {so.platforms!.map((p) => {
                const fmt = (v: number | null) => (v === null ? "—" : v.toLocaleString());
                const deltaTone = p.followers.delta > 0 ? "var(--ok)" : p.followers.delta < 0 ? "var(--bad)" : "var(--ink-3)";
                return (
                  <div
                    key={p.platform}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "180px 1fr",
                      gap: 16,
                      alignItems: "center",
                      padding: 12,
                      background: "var(--bg-1)",
                      border: "1px solid var(--line-soft)",
                      borderRadius: 10,
                    }}
                  >
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span
                          style={{
                            width: 8, height: 8, borderRadius: "50%",
                            background: CHANNEL_COLORS[p.platform] ?? "var(--ink-3)",
                          }}
                        />
                        <span style={{ fontWeight: 600, fontSize: 13, textTransform: "capitalize" }}>
                          {p.platform}
                        </span>
                      </div>
                      <div style={{ fontSize: 22, fontWeight: 600, marginTop: 6 }}>
                        {p.followers.current.toLocaleString()}
                        <span className="mono" style={{ fontSize: 11, color: deltaTone, marginInlineStart: 8 }}>
                          {p.followers.delta > 0 ? "+" : ""}
                          {p.followers.delta.toLocaleString()}
                        </span>
                      </div>
                      <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)", textTransform: "uppercase" }}>
                        {tx("Followers", "المتابعون")}
                      </div>
                      {p.followers.series.length > 1 && (
                        <div style={{ marginTop: 6 }}>
                          <Spark values={p.followers.series.map((s) => s.count)} w={140} h={24} />
                        </div>
                      )}
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
                      <Stat label={tx("Impressions", "مرات الظهور")} value={fmt(p.impressions)} />
                      <Stat label={tx("Reach", "الوصول")} value={fmt(p.reach)} />
                      <Stat
                        label={tx("Engagement", "التفاعل")}
                        value={fmt(
                          p.engagement ??
                            (p.likes === null && p.comments === null && p.shares === null
                              ? null
                              : (p.likes ?? 0) + (p.comments ?? 0) + (p.shares ?? 0)),
                        )}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
```

(No card renders for `not_connected`, empty `platforms`, or while loading — the section simply isn't there, matching the spec.)

- [ ] **Step 3: Typecheck + verify**

`npm run typecheck` → clean. Verify skill: Analytics shows the section with real numbers for the connected platforms; the 7/30 toggle refetches and changes the window totals; follower spark renders when history exists; a metric the platform doesn't provide shows "—" (check IG vs FB differences per the spike). Degradation check WITHOUT breaking the real account: intercept the overview fetch client-side (Playwright route or fetch monkey-patch) to return `{available:false, reason:"plan"}` and confirm the quiet card renders; same for `"upstream"`.

- [ ] **Step 4: Commit**

```bash
git add src/screens/Analytics.tsx
git commit -m "feat(analytics): social performance section from Zernio overview

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Verification pass

**Files:** none new (fixups as individual `fix: <what> found in Tier 1B verification` commits).

- [ ] **Step 1:** backend/: `npm test` green, `npm run build` clean.
- [ ] **Step 2:** root: `npm run typecheck && npm run build` clean.
- [ ] **Step 3: E2E sweep** (verify skill; read-only against Zernio):
  1. Analytics → Social performance shows the real platforms with live numbers on both windows; no fabricated zeros (absent metrics are "—").
  2. Internal sections above (tiles, message chart, channel mix, pipeline, campaigns) unchanged — regression check.
  3. Degradation cards render under intercepted `plan`/`upstream` responses; section absent when the overview returns `not_connected` (intercept again).
  4. Bilingual: switch to Arabic — section copy and layout mirror correctly.
- [ ] **Step 4:** Grep sweep on this plan's commits: no `console.log` added; no leftover spike scratch files.

---

## Self-review notes (spec → plan coverage)

- Spec §1 spike → Task 1 (shapes + 402, committed findings). §2 backend (client methods, mapper with fixed contract, nullable metrics, delta definition, degradation reasons, route with days handling) → Task 2. §3 frontend (section below message-volume card, shared days toggle, per-platform cards with Spark + delta badge, quiet degradation cards, nothing when not connected/empty, bilingual, "…"-free loading = section absent while loading) → Task 3. §4 error handling → Task 2 catch + Task 3 conditional rendering. §5 testing → Task 2 unit tests (all four reasons + mapping + summing + nulls), Task 4 E2E incl. intercepted degradation. Open items 1-3 → Task 1.
- Contract note: tests pin the OUTPUT shape; Task 2's Step 1 test explicitly marks mock INPUTS as adapt-to-spike. Task 3 consumes only the output contract, so it is insulated from spike surprises.
