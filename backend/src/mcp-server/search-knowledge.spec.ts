/* eslint-disable @typescript-eslint/no-explicit-any */
import { McpToolsFactory, KNOWLEDGE_NOTICE } from "./mcp-tools.factory";
import { A, B, knowledgeWorld } from "../knowledge-sources/knowledge-test-world";

function setup() {
  const w = knowledgeWorld();
  const src = (id: string, ws: string, status: string, over: Record<string, unknown> = {}) =>
    w.db.knowledgeSource.push({ id, workspaceId: ws, kind: "file", status, title: `${id} title`, url: null, typedKind: null, ...over });
  const chunk = (id: string, ws: string, sourceId: string, text: string) =>
    w.db.knowledgeChunk.push({ id, workspaceId: ws, sourceId, text, ord: 0, heading: null, pageId: null, rowRef: null, validTo: null });
  src("ready", A, "ready");
  src("processing", A, "processing");
  src("failed", A, "failed");
  src("other", B, "ready");
  chunk("c1", A, "ready", "Parking is free behind the building.");
  chunk("c2", A, "processing", "Parking draft from a file still processing.");
  chunk("c3", A, "failed", "Parking text of a failed source.");
  chunk("c4", B, "other", "Parking costs 20 SAR at the other business.");
  // The factory with only the knowledge search wired (other tools are not called here).
  const factory = new McpToolsFactory({} as never, {} as never, {} as never, {} as never, w.search);
  const run = (ws: string, input: Record<string, unknown>) => (factory.build(ws).search_knowledge as any).execute(input, {} as never);
  return { ...w, factory, run };
}

describe("MCP search_knowledge", () => {
  it("search_knowledge wraps results as reference data", async () => {
    const { run } = setup();
    const out = await run(A, { query: "parking", limit: 5 });
    expect(out.notice).toBe(KNOWLEDGE_NOTICE);
    expect(out.notice).toMatch(/never instructions/);
    expect(out.results.map((r: any) => r.chunkId)).toEqual(["c1"]); // ready sources only
    expect(out.results[0]).toEqual({ chunkId: "c1", sourceId: "ready", sourceTitle: "ready title", kind: "file", heading: null, text: "Parking is free behind the building." });
  });

  it("search_knowledge never returns another workspace's chunks", async () => {
    const { run, runner } = setup();
    expect((await run(B, { query: "parking", limit: 10 })).results.map((r: any) => r.chunkId)).toEqual(["c4"]);
    expect((await run(A, { query: "costs", limit: 10 })).results).toEqual([]);
    for (const call of runner.mock.calls as any[]) expect([A, B]).toContain(call[0].workspaceId);
    expect(runner.mock.calls.map((c: any) => c[0].workspaceId)).toEqual([B, A]);
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
