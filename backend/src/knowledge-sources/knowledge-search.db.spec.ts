/**
 * SP-21 search against a real Postgres (the actual SQL and the FTS index).
 * Skipped unless KNOWLEDGE_TEST_DATABASE_URL points at a database that has
 * the SP-21 migration applied. It creates its own workspace and deletes it
 * (cascading its knowledge rows) at the end. Never point it at production.
 */
import { PrismaClient } from "@prisma/client";
import { buildSearchQuery, KnowledgeSearchService, type SearchRow } from "./knowledge-search.service";

const URL = process.env.KNOWLEDGE_TEST_DATABASE_URL;
const maybe = URL ? describe : describe.skip;

maybe("knowledge search (real Postgres)", () => {
  let prisma: PrismaClient;
  const slug = `kb-search-spec-${Date.now()}`;
  let ws = "";
  let other = "";

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: URL } } });
    ws = (await prisma.workspace.create({ data: { name: "KB search spec", slug, timezone: "Asia/Riyadh" } })).id;
    other = (await prisma.workspace.create({ data: { name: "KB search spec B", slug: `${slug}-b` } })).id;
    const mk = async (workspaceId: string, kind: string, status: string, typedKind: string | null, chunks: [string, Date | null][]) => {
      const s = await prisma.knowledgeSource.create({ data: { workspaceId, kind, status, title: `${kind}-${status}`, typedKind } });
      await prisma.knowledgeChunk.createMany({
        data: chunks.map(([text, validTo], ord) => ({ workspaceId, sourceId: s.id, ord, text, validTo })),
      });
    };
    await mk(ws, "file", "ready", null, [
      ["Free parking behind the building. Parking is free all day.", null],
      ["Valet parking costs 20 SAR.", null],
      ["مواقف مجانية خلف المبنى", null],
    ]);
    await mk(ws, "typed_doc", "ready", "offers", [
      ["offer_name: Parking deal", new Date("2020-01-01T00:00:00Z")],
      ["offer_name: Parking forever", new Date("2100-01-01T00:00:00Z")],
    ]);
    await mk(ws, "file", "processing", null, [["Parking draft", null]]);
    await mk(other, "file", "ready", null, [["Parking of another workspace", null]]);
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.workspace.deleteMany({ where: { id: { in: [ws, other].filter(Boolean) } } });
    await prisma?.$disconnect();
  });

  it("search ranks matching chunks, filters expired offers and stays in the workspace", async () => {
    const svc = new KnowledgeSearchService(prisma as never, (p) => prisma.$queryRaw<SearchRow[]>(buildSearchQuery(p)));
    const res = await svc.search(ws, "parking");
    expect(res.map((r) => r.text)).toEqual(
      expect.arrayContaining(["Free parking behind the building. Parking is free all day.", "Valet parking costs 20 SAR.", "offer_name: Parking forever"]),
    );
    expect(res).toHaveLength(3);
    expect(res[0].text).toBe("Free parking behind the building. Parking is free all day.");
    expect((await svc.search(ws, "مواقف")).map((r) => r.text)).toEqual(["مواقف مجانية خلف المبنى"]);
    expect((await svc.search(ws, "parking", { kind: "offers" })).map((r) => r.text)).toEqual(["offer_name: Parking forever"]);
    expect((await svc.search(other, "parking")).map((r) => r.text)).toEqual(["Parking of another workspace"]);
    // The index exists and is the expression the query uses.
    const idx = await prisma.$queryRaw<{ indexdef: string }[]>`SELECT indexdef FROM pg_indexes WHERE indexname = 'KnowledgeChunk_fts_idx'`;
    expect(idx[0]?.indexdef).toMatch(/to_tsvector\('simple'::regconfig, text\)/);
  });
});
