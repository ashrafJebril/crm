/* eslint-disable @typescript-eslint/no-explicit-any */
import { KnowledgePublisher, KEWY_DOC_MAX } from "./knowledge-publisher";
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
  const publisher = new KnowledgePublisher(w.prisma as any, agentSetup as any, kewy as any);
  const svc = new KnowledgeSourcesService(w.prisma as any, w.media, w.processor, publisher);
  const row = (id: string) => w.db.knowledgeSource.find((s) => s.id === id)!;
  return { ...w, agentSetup, kewy, publisher, svc, row };
}

describe("KnowledgePublisher", () => {
  it("publisher failure never fails the save and is retried", async () => {
    const w = world({ l: true });
    w.agentSetup.writePromptBlock.mockRejectedValueOnce(Object.assign(new Error("l says: secret upstream text"), { name: "BadGatewayException" }));
    const saved = await w.svc.putGuidelines(A, "uOwner", { body: "Always answer in Arabic.", version: 0 });
    expect(saved).toMatchObject({ kind: "guideline", version: 1 });
    await flush();
    expect(w.row(saved.id).publishState).toBe("failed");
    // The retry sweep publishes it.
    expect(await w.publisher.retry()).toBe(1);
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
});
