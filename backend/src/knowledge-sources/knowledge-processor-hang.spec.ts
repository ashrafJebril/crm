import Anthropic from "@anthropic-ai/sdk";
import { ClaudeService, type ClaudeClientFactory } from "../ai/claude.service";
import { KnowledgeVision } from "./knowledge-vision";
import { MAX_RUN_MS } from "./knowledge-processor";
import { PROCESSING_STALL_MS } from "./knowledge-constants";
import { A, knowledgeWorld, pdf } from "./knowledge-test-world";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A Claude client whose stream never ends unless its AbortSignal fires (a body stalled mid-stream). */
function hangingClaude() {
  const seen: { signal?: AbortSignal }[] = [];
  const stream = jest.fn((_params: unknown, options?: { signal?: AbortSignal }) => {
    seen.push(options ?? {});
    return {
      finalMessage: () =>
        new Promise<never>((_, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Anthropic.APIUserAbortError()));
        }),
    };
  });
  const factory = jest.fn(() => ({ beta: { messages: { create: jest.fn(), stream } } }) as never) as unknown as ClaudeClientFactory;
  return { factory, stream, seen };
}

describe("KnowledgeProcessor against hung work", () => {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => (process.env.ANTHROPIC_API_KEY = "sk-test"));
  afterEach(() => {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
  });

  it("a stream that never ends is aborted at the timeout and its slot is freed", async () => {
    const claude = hangingClaude();
    const svc = new ClaudeService(claude.factory);
    (svc as unknown as { transcribeTimeoutMs: number }).transcribeTimeoutMs = 50;
    const w = knowledgeWorld({ vision: new KnowledgeVision(svc), pdfText: async () => ({ text: "", numpages: 3 }) });
    (w.processor as unknown as { heartbeatMs: number }).heartbeatMs = 5;
    const { items } = await w.svc.uploadFiles(A, "uOwner", [pdf()]);
    const started = Date.now();
    await expect(w.processor.run(items[0].id)).resolves.toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(claude.seen[0].signal).toBeInstanceOf(AbortSignal);
    expect(claude.seen[0].signal?.aborted).toBe(true);
    // The abort is transient: queued once more after the backoff; the slot is free.
    expect(w.db.knowledgeSource[0]).toMatchObject({ status: "queued", consecutiveFailures: 1, syncStartedAt: null });
    expect(w.processor.activeRuns()).toBe(0);
    // The heartbeat stopped with the run: no further lease writes.
    const writes = w.prisma.knowledgeSource.updateMany.mock.calls.length;
    await tick(40);
    expect(w.prisma.knowledgeSource.updateMany.mock.calls.length).toBe(writes);
  });

  it("a run past the absolute cap is failed even while it is still beating", async () => {
    // In process: the work hangs (not the stream), the heartbeat keeps beating, the cap ends the run.
    const w = knowledgeWorld({ pdfText: () => new Promise<never>(() => undefined) });
    const p = w.processor as unknown as { heartbeatMs: number; maxRunMs: number };
    p.heartbeatMs = 5;
    p.maxRunMs = 120;
    const { items } = await w.svc.uploadFiles(A, "uOwner", [pdf()]);
    const claimedAt = new Date();
    const leases: number[] = [];
    const watch = setInterval(() => {
      const l = w.db.knowledgeSource[0].leaseUntil;
      if (l) leases.push(l.getTime());
    }, 3);
    await expect(w.processor.run(items[0].id, claimedAt)).resolves.toBe(true);
    clearInterval(watch);
    expect(w.db.knowledgeSource[0]).toMatchObject({ status: "failed", error: "knowledge.processing_stalled", leaseUntil: null });
    expect(w.processor.activeRuns()).toBe(0);
    // The heartbeat beat but never moved the lease past the cap: the claim's
    // lease (claim + 20 min) already lies beyond it, so it was never extended.
    expect(leases.length).toBeGreaterThan(0);
    for (const l of leases) expect(l).toBeLessThanOrEqual(claimedAt.getTime() + PROCESSING_STALL_MS);

    // Across processes: a row whose lease is still fresh (beating) but claimed
    // more than the cap ago is failed by the sweep of any process.
    const now = new Date();
    w.db.knowledgeSource.push({
      ...w.db.knowledgeSource[0],
      id: "beating",
      status: "processing",
      error: null,
      leaseUntil: new Date(now.getTime() + 10 * 60 * 1000),
      syncStartedAt: new Date(now.getTime() - MAX_RUN_MS - 1000),
    });
    w.db.knowledgeSource.push({
      ...w.db.knowledgeSource[0],
      id: "young",
      status: "processing",
      error: null,
      leaseUntil: new Date(now.getTime() + 10 * 60 * 1000),
      syncStartedAt: new Date(now.getTime() - MAX_RUN_MS + 60_000),
    });
    const fresh = knowledgeWorld();
    fresh.db.knowledgeSource.push(...w.db.knowledgeSource.slice(1));
    expect(await fresh.processor.failStalled(now)).toBe(1);
    expect(fresh.db.knowledgeSource.find((s) => s.id === "beating")).toMatchObject({ status: "failed", error: "knowledge.processing_stalled" });
    expect(fresh.db.knowledgeSource.find((s) => s.id === "young")).toMatchObject({ status: "processing" });
  });
});
