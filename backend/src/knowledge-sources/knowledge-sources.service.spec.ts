import { A, B, failure, knowledgeWorld, pdf } from "./knowledge-test-world";
import { FAQ_ANSWER_MAX, FAQ_MAX, FAQ_QUESTION_MAX, GUIDELINES_MAX } from "./knowledge-constants";
import { previewGroups } from "./knowledge-sources.service";

const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

describe("KnowledgeSourcesService", () => {
  it("faq duplicates, limits and reorder", async () => {
    const w = knowledgeWorld();
    const a = await w.svc.createFaq(A, "uOwner", { question: "Do you have parking?", answer: "Yes, behind the building." });
    const b = await w.svc.createFaq(A, "uOwner", { question: "Are you open on Friday?", answer: "From 4 pm." });
    // New FAQs go on top.
    expect(b.order).toBeLessThan(a.order);
    expect((await w.svc.list(A, { kind: "faq" })).items.map((i) => i.id)).toEqual([b.id, a.id]);

    // Case-insensitive, trimmed, space-collapsed duplicate.
    expect(await failure(w.svc.createFaq(A, "uOwner", { question: "  do YOU have   parking? ", answer: "x" }))).toEqual({
      status: 400,
      body: { statusCode: 400, message: "knowledge.faq_duplicate" },
    });
    // The same question in another workspace is fine.
    await expect(w.svc.createFaq(B, "uOther", { question: "Do you have parking?", answer: "No" })).resolves.toMatchObject({ kind: "faq" });
    // Editing into a duplicate is refused too; editing itself is not.
    expect((await failure(w.svc.patchFaq(A, b.id, { question: "do you have parking?", version: b.version }))).body.message).toBe("knowledge.faq_duplicate");
    await expect(w.svc.patchFaq(A, a.id, { question: "Do you have PARKING?", version: a.version })).resolves.toMatchObject({ question: "Do you have PARKING?" });

    // Lengths.
    expect(await failure(w.svc.createFaq(A, "uOwner", { question: "q".repeat(FAQ_QUESTION_MAX + 1), answer: "a" }))).toEqual({
      status: 400,
      body: { statusCode: 400, message: "knowledge.faq_too_long", field: "question", max: FAQ_QUESTION_MAX },
    });
    expect((await failure(w.svc.createFaq(A, "uOwner", { question: "New?", answer: "a".repeat(FAQ_ANSWER_MAX + 1) }))).body).toMatchObject({
      message: "knowledge.faq_too_long",
      field: "answer",
    });
    // The cap.
    for (let i = 0; i < FAQ_MAX - 2; i++) w.db.knowledgeSource.push({ ...w.db.knowledgeSource[0], id: `f${i}`, question: `q${i}`, order: 10 + i });
    expect((await failure(w.svc.createFaq(A, "uOwner", { question: "One more?", answer: "no" }))).body).toEqual({
      statusCode: 400,
      message: "knowledge.faq_limit",
      limit: FAQ_MAX,
    });
    w.db.knowledgeSource = w.db.knowledgeSource.filter((r) => !/^f\d+$/.test(r.id));

    // Reorder: exactly the workspace's FAQ ids.
    const mismatch = { status: 400, body: { statusCode: 400, message: "knowledge.reorder_mismatch" } };
    const foreign = w.db.knowledgeSource.find((r) => r.workspaceId === B)!.id;
    expect(await failure(w.svc.reorderFaqs(A, { ids: [a.id] }))).toEqual(mismatch); // missing one
    expect(await failure(w.svc.reorderFaqs(A, { ids: [a.id, foreign] }))).toEqual(mismatch); // foreign
    expect(await failure(w.svc.reorderFaqs(A, { ids: [a.id, a.id] }))).toEqual(mismatch); // duplicated
    expect(await failure(w.svc.reorderFaqs(A, { ids: [a.id, b.id, "nope"] }))).toEqual(mismatch);
    const res = await w.svc.reorderFaqs(A, { ids: [a.id, b.id] });
    expect(res.items.map((i) => [i.id, i.order])).toEqual([
      [a.id, 0],
      [b.id, 1],
    ]);

    // Each FAQ is one searchable chunk.
    expect(w.db.knowledgeChunk.filter((c) => c.sourceId === a.id).map((c) => c.text)).toEqual(["Do you have PARKING?\nYes, behind the building."]);
  });

  it("stale content save is 409 with the current version", async () => {
    const w = knowledgeWorld();
    const first = await w.svc.putContent(A, "uOwner", { bodyJson: doc("We are a salon in Riyadh with free parking."), version: 0 });
    expect(first).toMatchObject({ kind: "content", version: 1, body: "We are a salon in Riyadh with free parking.", status: "ready" });
    const second = await w.svc.putContent(A, "uOwner", { bodyJson: doc("We are a salon in Jeddah, open every day."), version: 1 });
    expect(second.version).toBe(2);
    // A tab still holding version 1 saves: refused with the current row.
    const stale = await failure(w.svc.putContent(A, "uOwner", { bodyJson: doc("Old text from another tab, long enough."), version: 1 }));
    expect(stale.status).toBe(409);
    expect(stale.body.message).toBe("knowledge.version_conflict");
    expect(stale.body.current).toMatchObject({ id: first.id, version: 2, body: "We are a salon in Jeddah, open every day." });
    // Still one singleton, its chunks replaced (not appended).
    expect(w.db.knowledgeSource.filter((r) => r.kind === "content")).toHaveLength(1);
    expect(w.db.knowledgeChunk.filter((c) => c.sourceId === first.id).map((c) => c.text)).toEqual(["We are a salon in Jeddah, open every day."]);

    // Guidelines: same rules, no chunks, length cap.
    const g = await w.svc.putGuidelines(A, "uOwner", { body: "Always answer in Arabic.", version: 0 });
    expect(g).toMatchObject({ kind: "guideline", version: 1, body: "Always answer in Arabic." });
    expect(w.db.knowledgeChunk.filter((c) => c.sourceId === g.id)).toHaveLength(0);
    expect((await failure(w.svc.putGuidelines(A, "uOwner", { body: "x", version: 0 }))).status).toBe(409);
    expect((await failure(w.svc.putGuidelines(A, "uOwner", { body: "x".repeat(GUIDELINES_MAX + 1), version: 1 }))).body).toEqual({
      statusCode: 400,
      message: "knowledge.guidelines_too_long",
      max: GUIDELINES_MAX,
    });
  });

  it("preview groups by sheet, then heading, then General", async () => {
    expect(
      previewGroups("s1", [
        { id: "c1", heading: null, text: "intro", rowRef: null },
        { id: "c2", heading: "Prices", text: "name: Cut", rowRef: 2 },
        { id: "c3", heading: "Hours", text: "9 to 9", rowRef: null, page: { url: "https://x.example/hours" } },
        { id: "c4", heading: "Prices", text: "name: Color", rowRef: 3 },
        { id: "c5", heading: "  ", text: "more", rowRef: null },
      ]),
    ).toEqual({
      sourceId: "s1",
      truncated: false,
      groups: [
        {
          heading: null,
          items: [
            { chunkId: "c1", text: "intro", rowRef: null, url: null },
            { chunkId: "c5", text: "more", rowRef: null, url: null },
          ],
        },
        {
          heading: "Prices",
          items: [
            { chunkId: "c2", text: "name: Cut", rowRef: 2, url: null },
            { chunkId: "c4", text: "name: Color", rowRef: 3, url: null },
          ],
        },
        { heading: "Hours", items: [{ chunkId: "c3", text: "9 to 9", rowRef: null, url: "https://x.example/hours" }] },
      ],
    });
    const many = Array.from({ length: 201 }, (_, i) => ({ id: `c${i}`, heading: null, text: "t", rowRef: null }));
    const big = previewGroups("s", many);
    expect(big.truncated).toBe(true);
    expect(big.groups[0].items).toHaveLength(200);

    // Through the service, from the stored chunks.
    const w = knowledgeWorld();
    const c = await w.svc.putContent(A, "uOwner", {
      bodyJson: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Welcome to our salon, the best in town." }] },
          { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Hours" }] },
          { type: "paragraph", content: [{ type: "text", text: "Open daily from nine to nine, Friday from four." }] },
        ],
      },
      version: 0,
    });
    const p = await w.svc.preview(A, c.id);
    expect(p.groups.map((g) => g.heading)).toEqual([null, "Hours"]);
  });

  it("foreign and unknown ids are 404 knowledge.not_found on every id route", async () => {
    const w = knowledgeWorld();
    const mine = await w.svc.createFaq(A, "uOwner", { question: "Parking?", answer: "Yes" });
    const notFound = { status: 404, body: { statusCode: 404, message: "knowledge.not_found" } };
    const res = { setHeader: jest.fn(), send: jest.fn() } as never;
    for (const id of [mine.id, "nope"]) {
      expect(await failure(w.svc.get(B, id))).toEqual(notFound);
      expect(await failure(w.svc.preview(B, id))).toEqual(notFound);
      expect(await failure(w.svc.pages(B, id))).toEqual(notFound);
      expect(await failure(w.svc.sendFile(B, id, res))).toEqual(notFound);
      expect(await failure(w.svc.remove(B, id))).toEqual(notFound);
      expect(await failure(w.svc.reprocess(B, id))).toEqual(notFound);
      expect(await failure(w.svc.patchFaq(B, id, { answer: "x", version: 1 }))).toEqual(notFound);
    }
    expect(w.db.knowledgeSource.find((r) => r.id === mine.id)).toBeDefined();
  });

  it("delete removes the source, its chunks and its now-unused file", async () => {
    const w = knowledgeWorld({ pdfText: async () => ({ text: "Menu. ".repeat(100), numpages: 1 }) });
    const { items } = await w.svc.uploadFiles(A, "uOwner", [pdf()]);
    await w.processor.run(items[0].id);
    expect(w.db.knowledgeChunk.length).toBeGreaterThan(0);
    const mediaId = w.db.knowledgeSource[0].mediaId;
    await expect(w.svc.remove(A, items[0].id)).resolves.toEqual({ ok: true });
    expect(w.db.knowledgeSource).toHaveLength(0);
    expect(w.db.knowledgeChunk).toHaveLength(0);
    expect(w.db.media.find((m) => m.id === mediaId)).toBeUndefined();
    expect(w.objects.size).toBe(0);
  });
});
