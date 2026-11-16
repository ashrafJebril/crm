import { KNOWLEDGE_MAX_CONCURRENT_RUNS, RETRY_BACKOFF_MS } from "./knowledge-processor";
import { PROCESSING_STALL_MS } from "./knowledge-constants";
import { KnowledgeVision } from "./knowledge-vision";
import { ClaudeService } from "../ai/claude.service";
import { fakeClaude } from "../ai/claude-test-fake";
import { A, fakeVision, knowledgeWorld, KnowledgeFailure, pdf, PNG, upload } from "./knowledge-test-world";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("KnowledgeProcessor limits and retries", () => {
  it("ten kicks never run more than two at once, and every source still finishes", async () => {
    let active = 0;
    let peak = 0;
    const w = knowledgeWorld({
      pdfText: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await tick(5);
        active -= 1;
        return { text: "A menu with plenty of readable text. ".repeat(10), numpages: 1 };
      },
    });
    const { items } = await w.svc.uploadFiles(A, "uOwner", Array.from({ length: 10 }, (_, i) => pdf(`file ${i}`)));
    w.kick.mockRestore(); // real kicks: the in-process queue
    let peakRuns = 0;
    const timer = setInterval(() => (peakRuns = Math.max(peakRuns, w.processor.activeRuns())), 1);
    for (const s of items) w.processor.kick(s.id);
    const deadline = Date.now() + 10_000;
    while (w.db.knowledgeSource.some((s) => s.status !== "ready") && Date.now() < deadline) await tick(5);
    clearInterval(timer);
    expect(w.db.knowledgeSource.map((s) => s.status)).toEqual(Array(10).fill("ready"));
    expect(peak).toBe(KNOWLEDGE_MAX_CONCURRENT_RUNS);
    expect(peakRuns).toBeLessThanOrEqual(KNOWLEDGE_MAX_CONCURRENT_RUNS);
    expect(w.pdfText).toHaveBeenCalledTimes(10);
  });

  it("a run over the limit leaves the source queued for the sweep", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const w = knowledgeWorld({
      pdfText: async () => {
        await gate;
        return { text: "Readable menu text for the processor. ".repeat(10), numpages: 1 };
      },
    });
    const { items } = await w.svc.uploadFiles(A, "uOwner", [pdf("a"), pdf("b"), pdf("c")]);
    const runs = [w.processor.run(items[0].id), w.processor.run(items[1].id)];
    expect(await w.processor.run(items[2].id)).toBe(false);
    expect(w.db.knowledgeSource.find((s) => s.id === items[2].id)?.status).toBe("queued");
    release();
    await Promise.all(runs);
    expect(await w.processor.sweep()).toBe(1);
    expect(w.db.knowledgeSource.map((s) => s.status)).toEqual(["ready", "ready", "ready"]);
  });

  it("a transient provider failure is retried once after a backoff, then fails", async () => {
    const vision = fakeVision(new KnowledgeFailure("knowledge.ai_failed", true));
    const w = knowledgeWorld({ vision });
    const { items } = await w.svc.uploadFiles(A, "uOwner", [upload("board.png", PNG, "image/png")]);
    const id = items[0].id;
    const row = () => w.db.knowledgeSource.find((s) => s.id === id)!;
    const t0 = new Date();
    await w.processor.run(id, t0);
    expect(row()).toMatchObject({ status: "queued", error: null, consecutiveFailures: 1 });
    expect(row().leaseUntil.getTime()).toBeGreaterThanOrEqual(t0.getTime() + RETRY_BACKOFF_MS - 1000);
    // Not before the backoff.
    expect(await w.processor.sweep(new Date(t0.getTime() + 1000))).toBe(0);
    expect(vision.transcribe).toHaveBeenCalledTimes(1);
    // After it: retried; a second transient failure is final.
    expect(await w.processor.sweep(new Date(t0.getTime() + RETRY_BACKOFF_MS + 60_000))).toBe(1);
    expect(vision.transcribe).toHaveBeenCalledTimes(2);
    expect(row()).toMatchObject({ status: "failed", error: "knowledge.ai_failed" });
    // Reprocess resets the counter; a success keeps it at 0.
    await w.svc.reprocess(A, id);
    expect(row()).toMatchObject({ status: "queued", consecutiveFailures: 0, leaseUntil: null });
    vision.transcribe.mockResolvedValueOnce("Board with the opening hours of the salon.");
    await w.processor.run(id);
    expect(row()).toMatchObject({ status: "ready", consecutiveFailures: 0 });
    // A non-transient failure is final at once.
    const w2 = knowledgeWorld({ vision: fakeVision(new KnowledgeFailure("knowledge.ai_failed")) });
    const r2 = await w2.svc.uploadFiles(A, "uOwner", [upload("board.png", PNG, "image/png")]);
    await w2.processor.run(r2.items[0].id);
    expect(w2.db.knowledgeSource[0]).toMatchObject({ status: "failed", error: "knowledge.ai_failed", consecutiveFailures: 0 });
  });

  it("a live run extends its lease, so a long transcription is not failed as stalled", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const vision = fakeVision("x");
    vision.transcribe.mockImplementation(async () => {
      await gate;
      return "A long scanned catalogue, finally transcribed.";
    });
    const w = knowledgeWorld({ vision, pdfText: async () => ({ text: "", numpages: 90 }) });
    (w.processor as unknown as { heartbeatMs: number }).heartbeatMs = 10;
    const { items } = await w.svc.uploadFiles(A, "uOwner", [pdf()]);
    const t0 = new Date(Date.now() - PROCESSING_STALL_MS); // claimed "20 minutes ago"
    const running = w.processor.run(items[0].id, t0);
    await tick(80);
    // The heartbeat moved the lease past now: the stall sweep leaves it alone.
    expect(await w.processor.failStalled(new Date())).toBe(0);
    release();
    await running;
    expect(w.db.knowledgeSource[0]).toMatchObject({ status: "ready", error: null, leaseUntil: null });
  });

  it("a transcription that stops on max_tokens is not stored", async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-test";
    try {
      const partial = "Page 1 text ... page 63 text, cut off mid";
      const fake = fakeClaude({ content: [{ type: "text", text: partial }] as never, stop_reason: "max_tokens" as never });
      const vision = new KnowledgeVision(new ClaudeService(fake.factory));
      const w = knowledgeWorld({ vision, pdfText: async () => ({ text: "", numpages: 100 }) });
      const { items } = await w.svc.uploadFiles(A, "uOwner", [pdf()]);
      await w.processor.run(items[0].id);
      expect(fake.stream).toHaveBeenCalledTimes(1);
      expect(w.db.knowledgeSource[0]).toMatchObject({ status: "failed", error: "knowledge.pdf_too_long", itemCount: 0 });
      expect(w.db.knowledgeChunk).toHaveLength(0);
      expect(JSON.stringify(w.db)).not.toContain("cut off mid");
      // An image cut off the same way is ai_failed (no partial text either).
      const w2 = knowledgeWorld({ vision });
      const r2 = await w2.svc.uploadFiles(A, "uOwner", [upload("board.png", PNG, "image/png")]);
      await w2.processor.run(r2.items[0].id);
      expect(w2.db.knowledgeSource[0]).toMatchObject({ status: "failed", error: "knowledge.ai_failed" });
      expect(w2.db.knowledgeChunk).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});
