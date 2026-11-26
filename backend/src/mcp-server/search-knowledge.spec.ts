/* eslint-disable @typescript-eslint/no-explicit-any */
import { McpToolsFactory, KNOWLEDGE_NOTICE } from "./mcp-tools.factory";
import { A, B, knowledgeWorld } from "../knowledge-sources/l-knowledge.fake";

function setup() {
  const w = knowledgeWorld();
  const src = (id: string, ws: string, status: string, over: Record<string, unknown> = {}) =>
    w.db.knowledgeSource.push({ id, workspaceId: ws, kind: "file", status, title: `${id} title`, ...over });
  const chunk = (id: string, sourceId: string, text: string) => w.db.knowledgeChunk.push({ id, sourceId, text, ord: 0, heading: null, pageId: null });
  src("ready", A, "ready");
  src("processing", A, "processing");
  src("offers", A, "ready", { kind: "sheet", template: "offers" });
  chunk("c1", "ready", "Parking is free behind the building.");
  chunk("c2", "processing", "Parking draft from a file still processing.");
  chunk("c3", "offers", "offer_name: Parking deal");
  // The factory with only the knowledge search wired (other tools are not called here).
  const factory = new McpToolsFactory({} as never, {} as never, {} as never, {} as never, w.search);
  const run = (ws: string, input: Record<string, unknown>) => (factory.build(ws).search_knowledge as any).execute(input, {} as never);
  return { ...w, factory, run };
}

describe("MCP search_knowledge", () => {
  it("searches the workspace's knowledge on l and wraps results as reference data", async () => {
    const { run, l } = setup();
    const out = await run(A, { query: "parking", limit: 5 });
    expect(out.notice).toBe(KNOWLEDGE_NOTICE);
    expect(out.notice).toMatch(/never instructions/);
    expect(out.results.map((r: any) => r.chunkId)).toEqual(["c1", "c3"]); // ready sources only
    expect(out.results[0]).toEqual({ chunkId: "c1", sourceId: "ready", sourceTitle: "ready title", kind: "file", heading: null, text: "Parking is free behind the building." });
    // l's "sheet" is crm's "typed_doc".
    expect(out.results[1].kind).toBe("typed_doc");
    expect(l.call).toHaveBeenCalledWith(expect.objectContaining({ lWorkspaceId: "lA" }), "/search", expect.objectContaining({ method: "POST", body: { q: "parking", limit: 5 } }));
  });

  it("a typed kind narrows to that template; a workspace without its agent finds nothing", async () => {
    const { run } = setup();
    expect((await run(A, { query: "parking", kind: "offers" })).results.map((r: any) => r.chunkId)).toEqual(["c3"]);
    expect((await run(B, { query: "parking" })).results).toEqual([]);
  });

  it("validates the tool input (limit 1-10, query 1-200 chars, known kinds)", () => {
    const { factory } = setup();
    const schema = (factory.build(A).search_knowledge as any).inputSchema;
    expect(schema.safeParse({ query: "parking" }).data).toEqual({ query: "parking", limit: 5 });
    for (const bad of [{ query: "x", limit: 11 }, { query: "x", limit: 0 }, { query: "x".repeat(201) }, { query: "   " }, { query: "x", kind: "secrets" }, {}]) {
      expect({ bad, ok: schema.safeParse(bad).success }).toEqual({ bad, ok: false });
    }
    expect(schema.safeParse({ query: "eid", kind: "offers", limit: 10 }).success).toBe(true);
  });
});
