import { buildSearchQuery, escapeLike, normalizeQuery, todayIn, type SearchParams } from "./knowledge-search.service";
import { A, B, knowledgeWorld } from "./knowledge-test-world";

const base: SearchParams = { workspaceId: A, q: "parking", limit: 5, today: "2026-11-17", mode: "fts" };

describe("knowledge search", () => {
  it("search ranks matching chunks, filters expired offers and stays in the workspace", async () => {
    // The statement: indexed FTS expression, workspace on both tables, ready only, offer expiry.
    const sql = buildSearchQuery({ ...base, kind: "offers" });
    const text = sql.sql.replace(/\s+/g, " ");
    expect(text).toContain(`to_tsvector('simple', c."text") @@ websearch_to_tsquery('simple', ?)`);
    expect(text).toContain(`ts_rank(to_tsvector('simple', c."text"), websearch_to_tsquery('simple', ?))`);
    expect(text).toContain(`JOIN "KnowledgeSource" s ON s."id" = c."sourceId" AND s."workspaceId" = ?`);
    expect(text).toContain(`WHERE c."workspaceId" = ?`);
    expect(text).toContain(`s."status" = 'ready'`);
    expect(text).toContain(`(c."validTo" IS NULL OR c."validTo" >= ?::date)`);
    expect(text).toContain(`AND s."kind" = 'typed_doc' AND s."typedKind" = ?`);
    expect(text).toMatch(/LIMIT \?$/);
    expect(sql.values).toEqual([A, A, "parking", "2026-11-17", "offers", "parking", 5]);
    // The ILIKE fallback escapes wildcards.
    const like = buildSearchQuery({ ...base, q: "ع%", mode: "ilike" });
    expect(like.sql).toContain(`c."text" ILIKE ?`);
    expect(like.values[2]).toBe("%ع\\%%");
    expect(escapeLike("a_b\\c")).toBe("a\\_b\\\\c");
    expect(normalizeQuery("  free   parking ")).toEqual({ q: "free parking", mode: "fts" });
    expect(normalizeQuery("قص")).toEqual({ q: "قص", mode: "ilike" });
    expect(normalizeQuery("قصة")).toEqual({ q: "قصة", mode: "fts" });
    expect(normalizeQuery("x".repeat(300)).q).toHaveLength(200);

    // Today in the workspace timezone: 22:30 UTC on the 16th is already the 17th in Riyadh.
    const lateUtc = new Date("2026-11-16T22:30:00Z");
    expect(todayIn("Asia/Riyadh", lateUtc)).toBe("2026-11-17");
    expect(todayIn("Europe/London", lateUtc)).toBe("2026-11-16");
    expect(todayIn("Not/AZone", lateUtc)).toBe("2026-11-16");

    // Through the service over the token-match double.
    const w = knowledgeWorld();
    const src = (id: string, ws: string, over: Record<string, unknown> = {}) =>
      w.db.knowledgeSource.push({ id, workspaceId: ws, kind: "file", status: "ready", title: id, url: null, typedKind: null, ...over });
    const chunk = (id: string, ws: string, sourceId: string, text: string, ord = 0, validTo: Date | null = null) =>
      w.db.knowledgeChunk.push({ id, workspaceId: ws, sourceId, text, ord, heading: null, pageId: null, rowRef: null, validTo });
    src("s1", A);
    src("offers", A, { kind: "typed_doc", typedKind: "offers" });
    src("draft", A, { status: "processing" });
    src("other", B);
    chunk("c1", A, "s1", "Free parking behind the building. Parking is free all day.");
    chunk("c2", A, "s1", "Valet parking costs 20 SAR.", 1);
    chunk("c3", A, "offers", "offer_name: Parking deal; valid_to: 2026-11-16", 0, new Date("2026-11-16T00:00:00Z"));
    chunk("c4", A, "offers", "offer_name: Parking month; valid_to: 2026-11-17", 1, new Date("2026-11-17T00:00:00Z"));
    chunk("c5", A, "draft", "Parking draft text.");
    chunk("c6", B, "other", "Parking of workspace B.");

    const now = lateUtc; // 2026-11-17 in Riyadh: the offer ending on the 16th is expired
    const res = await w.search.search(A, "parking", { now });
    expect(res.map((r) => r.chunkId)).toEqual(["c1", "c2", "c4"]);
    expect(res[0]).toEqual({ chunkId: "c1", sourceId: "s1", sourceTitle: "s1", kind: "file", heading: null, text: "Free parking behind the building. Parking is free all day." });
    expect(w.runner.mock.calls[0][0]).toMatchObject({ workspaceId: A, today: "2026-11-17", limit: 5, mode: "fts" });
    // Kind filter, limit clamp, empty query, other workspace.
    expect((await w.search.search(A, "parking", { kind: "offers", now })).map((r) => r.chunkId)).toEqual(["c4"]);
    expect(await w.search.search(A, "parking", { limit: 1, now })).toHaveLength(1);
    await w.search.search(A, "parking", { limit: 99, now });
    expect(w.runner.mock.calls.at(-1)![0].limit).toBe(10);
    expect(await w.search.search(A, "   ")).toEqual([]);
    expect((await w.search.search(B, "parking", { now })).map((r) => r.chunkId)).toEqual(["c6"]);
    expect(await w.search.search("wsNone", "parking")).toEqual([]);
  });
});
