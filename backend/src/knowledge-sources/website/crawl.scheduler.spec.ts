/* eslint-disable @typescript-eslint/no-explicit-any */
import { CrawlScheduler, CRAWL_MAX_CONCURRENT } from "./crawl.scheduler";
import { website, A, B } from "./crawl-test-world";
import { knowledgeWorld } from "../knowledge-test-world";

describe("CrawlScheduler", () => {
  it("runs due websites, never paused or failed ones, at most two at a time and one per workspace", async () => {
    const w = knowledgeWorld();
    const now = new Date("2026-11-17T10:00:00Z");
    const due = new Date(now.getTime() - 1000);
    const a1 = website(w.db, { status: "ready", nextSyncAt: due });
    const a2 = website(w.db, { status: "ready", nextSyncAt: due });
    const b1 = website(w.db, { workspaceId: B, status: "queued", nextSyncAt: due });
    website(w.db, { status: "paused", nextSyncAt: due });
    website(w.db, { status: "failed", nextSyncAt: null });
    website(w.db, { status: "ready", nextSyncAt: new Date(now.getTime() + 60_000) });
    website(w.db, { status: "ready", nextSyncAt: due, syncStartedAt: new Date(now.getTime() - 60_000) }); // running elsewhere
    const started: string[] = [];
    const release: (() => void)[] = [];
    const runner = {
      run: jest.fn((id: string) => {
        started.push(id);
        return new Promise((r) => release.push(() => r(null)));
      }),
    };
    const s = new CrawlScheduler(w.prisma as any, runner as any);
    expect(await s.sweep(now)).toBe(2);
    expect(started.sort()).toEqual([a1.id, b1.id].sort());
    expect(s.activeRuns()).toBe(CRAWL_MAX_CONCURRENT);
    // No room: a kick waits for the sweep.
    expect(s.kick(a2.id, A)).toBe(false);
    release.forEach((r) => r());
    await new Promise((r) => setImmediate(r));
    expect(s.activeRuns()).toBe(0);
    expect(s.kick(a2.id, A)).toBe(true);
  });
});
