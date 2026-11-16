import { KnowledgeProcessor } from "./knowledge-processor";
import { PROCESSING_STALL_MS } from "./knowledge-constants";
import { A, fakeVision, knowledgeWorld, pdf } from "./knowledge-test-world";

describe("KnowledgeProcessor", () => {
  it("processor fails a source stuck in processing for 20 minutes", async () => {
    const w = knowledgeWorld();
    const now = new Date("2026-11-17T10:00:00Z");
    const claimedAt = (msAgo: number) => new Date(now.getTime() - msAgo + PROCESSING_STALL_MS);
    const base = { workspaceId: A, kind: "file", title: "f", status: "processing", error: null, version: 0, createdAt: now, updatedAt: now };
    w.db.knowledgeSource.push(
      { ...base, id: "stuck", leaseUntil: claimedAt(PROCESSING_STALL_MS + 1) },
      { ...base, id: "busy", leaseUntil: claimedAt(19 * 60 * 1000) },
      { ...base, id: "site", kind: "website", leaseUntil: claimedAt(PROCESSING_STALL_MS + 1) },
    );
    await w.processor.sweep(now);
    const by = (id: string) => w.db.knowledgeSource.find((r) => r.id === id);
    expect(by("stuck")).toMatchObject({ status: "failed", error: "knowledge.processing_stalled", leaseUntil: null });
    expect(by("busy")).toMatchObject({ status: "processing", error: null });
    // Websites have their own lease (Task 2).
    expect(by("site")).toMatchObject({ status: "processing" });

    // A run that outlived its lease cannot write afterwards (fenced on the lease).
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = knowledgeWorld({
      pdfText: async () => {
        await gate;
        return { text: "Slow menu text. ".repeat(50), numpages: 1 };
      },
    });
    const { items } = await slow.svc.uploadFiles(A, "uOwner", [pdf()]);
    const t0 = new Date();
    const running = slow.processor.run(items[0].id, t0);
    await new Promise((r) => setImmediate(r));
    await slow.processor.failStalled(new Date(t0.getTime() + PROCESSING_STALL_MS + 1));
    release();
    await running;
    expect(await slow.svc.get(A, items[0].id)).toMatchObject({ status: "failed", error: "knowledge.processing_stalled" });
    expect(slow.db.knowledgeChunk).toHaveLength(0);
  });

  it("processor lease prevents a double run", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const vision = fakeVision("Scanned price list with enough text.");
    vision.transcribe.mockImplementation(async () => {
      await gate;
      return "Scanned price list with enough text.";
    });
    const w = knowledgeWorld({ vision, pdfText: async () => ({ text: "", numpages: 1 }) });
    const { items } = await w.svc.uploadFiles(A, "uOwner", [pdf()]);
    // A second process over the same database.
    const other = new KnowledgeProcessor(w.prisma as never, w.media, vision, w.pdfText);
    const first = w.processor.run(items[0].id);
    const second = other.run(items[0].id);
    const sameProcess = w.processor.run(items[0].id);
    const sweep = other.sweep();
    release();
    expect(await Promise.all([first, second, sameProcess, sweep])).toEqual([true, false, false, 0]);
    expect(vision.transcribe).toHaveBeenCalledTimes(1);
    expect(await w.svc.get(A, items[0].id)).toMatchObject({ status: "ready", itemCount: 1 });
    expect(w.db.knowledgeChunk).toHaveLength(1);
  });

  it("the sweep picks queued sources and ignores other kinds", async () => {
    const w = knowledgeWorld({ pdfText: async () => ({ text: "Menu with plenty of text. ".repeat(20), numpages: 1 }) });
    const { items } = await w.svc.uploadFiles(A, "uOwner", [pdf(), pdf("other")]);
    w.db.knowledgeSource.push({ ...w.db.knowledgeSource[0], id: "web", kind: "website", status: "queued" });
    expect(await w.processor.sweep()).toBe(2);
    expect(items.map((i) => w.db.knowledgeSource.find((r) => r.id === i.id)?.status)).toEqual(["ready", "ready"]);
    expect(w.db.knowledgeSource.find((r) => r.id === "web")?.status).toBe("queued");
  });
});
