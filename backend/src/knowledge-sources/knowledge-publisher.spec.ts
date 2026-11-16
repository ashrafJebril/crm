/* eslint-disable @typescript-eslint/no-explicit-any */
import { KnowledgePublisher, KEWY_DOC_MAX, PUBLISH_MAX_ATTEMPTS, publishBackoffMs } from "./knowledge-publisher";
import { TOMBSTONE_KIND } from "./knowledge-constants";
import { KnowledgeSourcesService } from "./knowledge-sources.service";
import { A, knowledgeWorld } from "./knowledge-test-world";

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

function world(opts: { l?: boolean; kewy?: boolean } = {}) {
  const w = knowledgeWorld();
  const ws = w.db.workspace.find((x) => x.id === A)!;
  ws.lWorkspaceId = opts.l ? "l-1" : null;
  ws.externalTenantId = opts.kewy ? "hjz-1" : null;
  const agentSetup = { writePromptBlock: jest.fn(async () => "updated") };
  let n = 0;
  const kewy = {
    isConfigured: jest.fn(() => true),
    upsertDoc: jest.fn(async (input: any) => ({ ...input, id: input.id ?? `doc_${++n}` })),
    deleteDoc: jest.fn(async (_t: string, id: string) => ({ ok: true, id })),
  };
  const lKnowledge = { remove: jest.fn(async () => undefined) };
  const publisher = new KnowledgePublisher(w.prisma as any, agentSetup as any, kewy as any, lKnowledge as any);
  const svc = new KnowledgeSourcesService(w.prisma as any, w.media, w.processor, publisher);
  const row = (id: string) => w.db.knowledgeSource.find((s) => s.id === id)!;
  /** Hold the next `count` kewy-ai upserts until released (in order). */
  const held: (() => void)[] = [];
  const holdUpserts = (count = Infinity) => {
    const real = kewy.upsertDoc.getMockImplementation()!;
    let left = count;
    kewy.upsertDoc.mockImplementation(async (input: any) => {
      if (left-- > 0) await new Promise<void>((r) => held.push(r));
      return real(input);
    });
  };
  const releaseAll = async () => {
    for (let i = 0; i < 50; i++) {
      await flush();
      const r = held.shift();
      if (r) r();
      else return;
    }
  };
  const tick = () => new Promise((r) => setTimeout(r, 3));
  const tombstones = () => w.db.knowledgeSource.filter((s) => s.kind === TOMBSTONE_KIND);
  return { ...w, agentSetup, kewy, lKnowledge, publisher, svc, row, held, holdUpserts, releaseAll, tick, tombstones };
}

describe("KnowledgePublisher", () => {
  it("publisher failure never fails the save and is retried", async () => {
    const w = world({ l: true });
    w.agentSetup.writePromptBlock.mockRejectedValueOnce(Object.assign(new Error("l says: secret upstream text"), { name: "BadGatewayException" }));
    const saved = await w.svc.putGuidelines(A, "uOwner", { body: "Always answer in Arabic.", version: 0 });
    expect(saved).toMatchObject({ kind: "guideline", version: 1 });
    await flush();
    expect(w.row(saved.id).publishState).toBe("failed");
    // The retry sweep publishes it once its first backoff (1 min) has passed.
    expect(await w.publisher.retry()).toBe(0);
    expect(await w.publisher.retry(new Date(Date.now() + 61_000))).toBe(1);
    expect(w.row(saved.id).publishState).toBe("published");
    expect(w.agentSetup.writePromptBlock).toHaveBeenLastCalledWith(A, "guidelines", "Always answer in Arabic.");
    // l agents get no copies of other kinds: only the guidelines go into the prompt.
    const faq = await w.svc.createFaq(A, "uOwner", { question: "Parking?", answer: "Yes, free." });
    await flush();
    expect(w.row(faq.id).publishState).toBe("none");
    expect(w.agentSetup.writePromptBlock).toHaveBeenCalledTimes(2);
    expect(w.kewy.upsertDoc).not.toHaveBeenCalled();
    // Deleting the guidelines removes the block.
    await w.svc.remove(A, saved.id);
    expect(w.agentSetup.writePromptBlock).toHaveBeenLastCalledWith(A, "guidelines", "");
  });

  it("kewy copies upserted with the same upstream id and deleted with the source", async () => {
    const w = world({ kewy: true });
    const faq = await w.svc.createFaq(A, "uOwner", { question: "Do you have parking?", answer: "Yes, behind the building." });
    await flush();
    expect(w.kewy.upsertDoc).toHaveBeenLastCalledWith({ tenantId: A, id: undefined, title: "Do you have parking?", body: "Yes, behind the building.", kind: "FAQ" });
    expect(w.row(faq.id)).toMatchObject({ publishState: "published", upstream: { kewy: { docId: "doc_1" } } });

    await w.svc.patchFaq(A, faq.id, { answer: "Yes, free for customers.", version: faq.version });
    await flush();
    expect(w.kewy.upsertDoc).toHaveBeenLastCalledWith(expect.objectContaining({ id: "doc_1", body: "Yes, free for customers." }));
    expect(w.kewy.upsertDoc).toHaveBeenCalledTimes(2);

    const content = await w.svc.putContent(A, "uOwner", {
      bodyJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "We are a salon in Riyadh." }] }] },
      version: 0,
    });
    await flush();
    expect(w.kewy.upsertDoc).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "OTHER", body: "We are a salon in Riyadh.", id: undefined }));

    // Delete removes the upstream copy (best-effort).
    await w.svc.remove(A, faq.id);
    expect(w.kewy.deleteDoc).toHaveBeenCalledWith(A, "doc_1");
    w.kewy.deleteDoc.mockRejectedValueOnce(new Error("down"));
    await expect(w.svc.remove(A, content.id)).resolves.toEqual({ ok: true });

    // A long file is truncated to the kewy-ai cap and the truncation recorded.
    const big = { id: "src_big", workspaceId: A, kind: "file", status: "ready", title: "Catalogue", body: null, question: null, upstream: null, publishState: "none" };
    w.db.knowledgeSource.push(big);
    w.db.knowledgeChunk.push({ id: "c_big", workspaceId: A, sourceId: "src_big", pageId: null, ord: 0, heading: null, text: "x".repeat(KEWY_DOC_MAX + 10), rowRef: null, validTo: null });
    expect(await w.publisher.publish("src_big")).toBe("published");
    expect((w.kewy.upsertDoc.mock.calls.at(-1) as any)[0].body).toHaveLength(KEWY_DOC_MAX);
    expect(w.row("src_big").upstream).toMatchObject({ kewy: { truncated: true } });
  });

  it("a workspace with neither l nor kewy-ai publishes nothing", async () => {
    const w = world();
    const faq = await w.svc.createFaq(A, "uOwner", { question: "Q?", answer: "A." });
    await flush();
    expect(w.row(faq.id).publishState).toBe("none");
    expect(w.agentSetup.writePromptBlock).not.toHaveBeenCalled();
    expect(w.kewy.upsertDoc).not.toHaveBeenCalled();
  });

  it("create followed by a quick edit publishes exactly one upstream doc with the latest content", async () => {
    const w = world({ kewy: true });
    w.holdUpserts();
    const faq = await w.svc.createFaq(A, "uOwner", { question: "Parking?", answer: "Yes, behind the building." });
    await flush();
    expect(w.held).toHaveLength(1); // the create is in flight
    await w.tick();
    await w.svc.patchFaq(A, faq.id, { answer: "Yes, free for customers.", version: faq.version });
    await w.releaseAll();
    const creates = w.kewy.upsertDoc.mock.calls.filter((c: any) => c[0].id === undefined);
    expect(creates).toHaveLength(1);
    expect(w.kewy.deleteDoc).not.toHaveBeenCalled();
    expect((w.kewy.upsertDoc.mock.calls.at(-1) as any)[0]).toMatchObject({ id: "doc_1", body: "Yes, free for customers." });
    expect(w.row(faq.id)).toMatchObject({ publishState: "published", upstream: { kewy: { docId: "doc_1" }, publishedVersion: 2 } });
  });

  it("an older publish that completes last never overwrites newer content (out-of-order completion)", async () => {
    const w = world({ kewy: true });
    const faq = await w.svc.createFaq(A, "uOwner", { question: "Parking?", answer: "v1" });
    await flush();
    expect(w.row(faq.id).upstream).toMatchObject({ kewy: { docId: "doc_1" } });
    // Two processes: separate publishers (separate in-process queues) over one database.
    const other = new KnowledgePublisher(w.prisma as any, w.agentSetup as any, w.kewy as any);
    Object.assign(w.row(faq.id), { body: "v2", version: 2 });
    w.holdUpserts(1);
    const slow = w.publisher.publish(faq.id); // reads v2, then stalls in the upsert
    await flush();
    expect(w.held).toHaveLength(1);
    await w.tick();
    Object.assign(w.row(faq.id), { body: "v3", version: 3, updatedAt: new Date() });
    expect(await other.publish(faq.id)).toBe("published"); // v3 lands first
    await w.releaseAll();
    expect(await slow).toBe("published");
    // The stale v2 write lost its compare-and-set and published v3 again.
    expect((w.kewy.upsertDoc.mock.calls.at(-1) as any)[0]).toMatchObject({ id: "doc_1", body: "v3" });
    expect(w.kewy.upsertDoc.mock.calls.filter((c: any) => c[0].id === undefined)).toHaveLength(1);
    expect(w.row(faq.id).upstream).toMatchObject({ kewy: { docId: "doc_1" }, publishedVersion: 3 });
  });

  it("a publish racing another process's first publish keeps one doc and deletes its own", async () => {
    const w = world({ kewy: true });
    const other = new KnowledgePublisher(w.prisma as any, w.agentSetup as any, w.kewy as any);
    w.db.knowledgeSource.push({ id: "src_r", workspaceId: A, kind: "faq", status: "ready", title: "Q?", question: "Q?", body: "A.", upstream: null, publishState: "pending", version: 1, updatedAt: new Date() });
    w.holdUpserts(1);
    const slow = w.publisher.publish("src_r"); // creates doc_2 after the other's doc_1
    await flush();
    await w.tick();
    expect(await other.publish("src_r")).toBe("published");
    await w.releaseAll();
    await slow;
    expect(w.row("src_r").upstream).toMatchObject({ kewy: { docId: "doc_1" } });
    expect(w.kewy.deleteDoc).toHaveBeenCalledWith(A, "doc_2");
  });

  it("delete during an in-flight publish leaves no upstream doc", async () => {
    const w = world({ kewy: true });
    w.holdUpserts(1);
    const faq = await w.svc.createFaq(A, "uOwner", { question: "Parking?", answer: "Yes." });
    await flush();
    expect(w.held).toHaveLength(1);
    const removing = w.svc.remove(A, faq.id);
    await w.releaseAll();
    await expect(removing).resolves.toEqual({ ok: true });
    await flush();
    const created = (await Promise.all(w.kewy.upsertDoc.mock.results.map((r: any) => r.value))).map((d: any) => d.id);
    expect(created).toEqual(["doc_1"]);
    expect(w.kewy.deleteDoc).toHaveBeenCalledWith(A, "doc_1");
    expect(w.db.knowledgeSource).toHaveLength(0);
  });

  it("a failed upstream delete leaves a hidden tombstone that the sweep retries with backoff", async () => {
    const w = world({ kewy: true });
    const faq = await w.svc.createFaq(A, "uOwner", { question: "Parking?", answer: "Yes." });
    await flush();
    w.kewy.deleteDoc.mockRejectedValueOnce(new Error("down"));
    await expect(w.svc.remove(A, faq.id)).resolves.toEqual({ ok: true });
    expect(w.tombstones()).toHaveLength(1);
    expect(w.tombstones()[0]).toMatchObject({ workspaceId: A, publishState: "failed", upstream: { kewy: { docId: "doc_1" }, publish: { attempts: 1 } } });
    // Never listed, never loadable.
    expect((await w.svc.list(A)).items).toHaveLength(0);
    await expect(w.svc.get(A, w.tombstones()[0].id)).rejects.toBeTruthy();
    // Not before its backoff; then deleted and the tombstone dropped.
    expect(await w.publisher.retry()).toBe(0);
    expect(w.kewy.deleteDoc).toHaveBeenCalledTimes(1);
    expect(await w.publisher.retry(new Date(Date.now() + 61_000))).toBe(1);
    expect(w.kewy.deleteDoc).toHaveBeenLastCalledWith(A, "doc_1");
    expect(w.tombstones()).toHaveLength(0);
  });

  it("deleting a migrated l document source deletes the l document too, retried when it fails", async () => {
    const w = world({ l: true });
    w.db.knowledgeSource.push({ id: "src_l", workspaceId: A, kind: "file", status: "ready", title: "Menu.pdf", body: null, question: null, upstream: { l: { documentId: "L1" } }, legacyRef: "l:L1", publishState: "none", version: 0, mediaId: null });
    w.lKnowledge.remove.mockRejectedValueOnce(new Error("l down"));
    await w.svc.remove(A, "src_l");
    expect(w.lKnowledge.remove).toHaveBeenCalledWith(A, "L1");
    expect(w.tombstones()).toHaveLength(1);
    expect(await w.publisher.retry(new Date(Date.now() + 61_000))).toBe(1);
    expect(w.lKnowledge.remove).toHaveBeenCalledTimes(2);
    expect(w.tombstones()).toHaveLength(0);
  });

  it("publish retries back off exponentially and stop after the max attempts until the next save", async () => {
    expect([1, 2, 3, 4, 7, 8, 20].map((n) => publishBackoffMs(n) / 60_000)).toEqual([1, 2, 4, 8, 60, 60, 60]);
    const w = world({ l: true });
    w.agentSetup.writePromptBlock.mockRejectedValue(new Error("l down"));
    const saved = await w.svc.putGuidelines(A, "uOwner", { body: "Be brief.", version: 0 });
    await flush();
    expect(w.row(saved.id)).toMatchObject({ publishState: "failed", upstream: { publish: { attempts: 1 } } });
    for (let attempt = 1; attempt < PUBLISH_MAX_ATTEMPTS; attempt++) {
      const failedAt = w.row(saved.id).updatedAt.getTime();
      // Before its backoff: not retried.
      expect(await w.publisher.retry(new Date(failedAt + publishBackoffMs(attempt) - 5_000))).toBe(0);
      expect(w.row(saved.id).upstream.publish.attempts).toBe(attempt);
      // After it: retried (and failing again).
      expect(await w.publisher.retry(new Date(failedAt + publishBackoffMs(attempt) + 1_000))).toBe(0);
      expect(w.row(saved.id).upstream.publish.attempts).toBe(attempt + 1);
    }
    const calls = w.agentSetup.writePromptBlock.mock.calls.length;
    expect(calls).toBe(PUBLISH_MAX_ATTEMPTS);
    // Exhausted: no more retries, however late.
    await w.publisher.retry(new Date(Date.now() + 365 * 86_400_000));
    expect(w.agentSetup.writePromptBlock).toHaveBeenCalledTimes(calls);
    expect(w.row(saved.id).publishState).toBe("failed");
    // The next save publishes again and starts counting afresh.
    w.agentSetup.writePromptBlock.mockResolvedValue("updated");
    await w.svc.putGuidelines(A, "uOwner", { body: "Be very brief.", version: 1 });
    await flush();
    expect(w.row(saved.id).publishState).toBe("published");
    expect(w.row(saved.id).upstream.publish).toBeUndefined();
  });

  it("the guidelines publish updates the migrated TONE doc in place", async () => {
    const w = world({ kewy: true });
    w.db.knowledgeSource.push({ id: "src_g", workspaceId: A, kind: "guideline", status: "ready", title: "Guidelines", body: "Be warm.", question: null, upstream: { kewyTone: ["k3", "k4"], kewy: { docId: "k3" } }, publishState: "none", version: 1, createdAt: new Date() });
    await w.svc.putGuidelines(A, "uOwner", { body: "Be warm and brief.", version: 1 });
    await flush();
    expect(w.kewy.upsertDoc).toHaveBeenCalledTimes(1);
    expect(w.kewy.upsertDoc).toHaveBeenLastCalledWith(expect.objectContaining({ id: "k3", kind: "TONE", body: "Be warm and brief." }));
    expect(w.row("src_g").upstream).toMatchObject({ kewy: { docId: "k3" }, kewyTone: ["k3", "k4"] });
  });
});
