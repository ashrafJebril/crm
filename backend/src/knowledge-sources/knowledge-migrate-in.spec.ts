/* eslint-disable @typescript-eslint/no-explicit-any */
import { migrateIn } from "./knowledge-migrate-in";
import { A, B, knowledgeWorld } from "./knowledge-test-world";

const doc = (over: Record<string, unknown>) => ({
  id: "d",
  tenantId: A,
  kind: "OTHER",
  title: "Doc",
  body: "Some long enough text about the business and its services.",
  sourceRef: null,
  syncedAt: null,
  updatedAt: "2026-11-01T00:00:00Z",
  editable: true,
  ...over,
});

function setup() {
  const w = knowledgeWorld();
  w.db.workspace.find((x) => x.id === A)!.lWorkspaceId = "l-1";
  const kewy = {
    [A]: [
      doc({ id: "k1", kind: "FAQ", title: "Do you have parking?", body: "Yes, behind the building." }),
      doc({ id: "k2", kind: "POLICY", title: "Cancellation policy", body: "Cancel up to 24 hours before your booking for a full refund." }),
      doc({ id: "k3", kind: "TONE", title: "Tone", body: "Be warm and brief." }),
      doc({ id: "k4", kind: "TONE", title: "Tone 2", body: "Answer in the customer's language." }),
      // HJZ-synced: never migrated.
      doc({ id: "h1", kind: "SERVICE_DESCRIPTION", title: "Haircut", sourceRef: "hjz:service:1", syncedAt: "2026-11-01T00:00:00Z", editable: false }),
    ],
    [B]: [],
  } as Record<string, any[]>;
  const l = { [A]: [{ id: "L1", title: "Menu.pdf", source_type: "file", status: "ready", meta: {}, created_at: "" }, { id: "L2", title: "Broken.pdf", source_type: "file", status: "error", meta: {}, created_at: "" }] } as Record<string, any[]>;
  const deps = {
    db: w.prisma as any,
    kewyDocs: jest.fn(async (ws: string) => kewy[ws] ?? []),
    lDocs: jest.fn(async (ws: string) => l[ws] ?? []),
  };
  return { ...w, deps };
}

describe("knowledge migrate-in", () => {
  it("migrate-in is rerunnable", async () => {
    const w = setup();
    // Dry run (the default the script uses): counts, writes nothing.
    const dry = await migrateIn(w.deps, { workspaceIds: "all", dryRun: true });
    expect(dry).toMatchObject({ workspaces: 2, faq: 1, file: 1, guidelines: 2, lDocuments: 2, hjzSyncedSkipped: 1 });
    expect(w.db.knowledgeSource).toHaveLength(0);
    expect(w.db.knowledgeChunk).toHaveLength(0);

    const first = await migrateIn(w.deps, { workspaceIds: [A], dryRun: false });
    expect(first).toMatchObject({ workspaces: 1, faq: 1, file: 1, guidelines: 2, lDocuments: 2, existing: 0 });
    const by = (ref: string) => w.db.knowledgeSource.find((s) => s.legacyRef === ref);
    expect(by("kewy:k1")).toMatchObject({ kind: "faq", question: "Do you have parking?", body: "Yes, behind the building.", upstream: { kewy: { docId: "k1" } } });
    expect(by("kewy:k2")).toMatchObject({ kind: "file", status: "ready", mediaId: null, upstream: { kewy: { docId: "k2" } } });
    expect(w.db.knowledgeChunk.some((c) => c.sourceId === by("kewy:k2").id)).toBe(true);
    expect(by("l:L1")).toMatchObject({ kind: "file", status: "ready", upstream: { l: { documentId: "L1" } } });
    expect(by("l:L2")).toMatchObject({ status: "failed" });
    const g = w.db.knowledgeSource.find((s) => s.kind === "guideline");
    expect(g.body).toBe("Be warm and brief.\n\nAnswer in the customer's language.");
    // The guidelines reuse the migrated TONE doc upstream, so a later save updates it in place.
    expect(g.upstream).toMatchObject({ kewy: { docId: "k3" }, kewyTone: ["k3", "k4"] });
    const rows = w.db.knowledgeSource.length;

    // Second run: nothing new, nothing appended twice.
    const second = await migrateIn(w.deps, { workspaceIds: [A], dryRun: false });
    expect(second).toMatchObject({ faq: 0, file: 0, guidelines: 0, lDocuments: 0, existing: 6 });
    expect(w.db.knowledgeSource).toHaveLength(rows);
    expect(w.db.knowledgeSource.find((s) => s.kind === "guideline").body).toBe(g.body);
    expect(w.db.knowledgeSource.find((s) => s.kind === "guideline").upstream.kewy).toEqual({ docId: "k3" });
    // Upstream is only read, never changed or deleted.
    expect(Object.keys(w.deps).sort()).toEqual(["db", "kewyDocs", "lDocs"]);
  });

  it("hjz synced docs are never migrated", async () => {
    const w = setup();
    await migrateIn(w.deps, { workspaceIds: [A], dryRun: false });
    expect(w.db.knowledgeSource.some((s) => s.legacyRef === "kewy:h1")).toBe(false);
    expect(w.db.knowledgeSource.some((s) => s.title === "Haircut")).toBe(false);
  });

  it("docs SP-21 published itself are never re-imported", async () => {
    const w = setup();
    // Sources this CRM already publishes to kewy-ai (and a tombstone still deleting one).
    w.db.knowledgeSource.push(
      { id: "own_content", workspaceId: A, kind: "content", status: "ready", title: "Business", body: "We are a salon.", upstream: { kewy: { docId: "p1" } }, legacyRef: null },
      { id: "own_faq", workspaceId: A, kind: "faq", status: "ready", title: "Open on Friday?", question: "Open on Friday?", body: "Yes.", upstream: { kewy: { docId: "p3" } }, legacyRef: null },
      { id: "own_tomb", workspaceId: A, kind: "tombstone", status: "deleted", title: "Deleted knowledge source", upstream: { kewy: { docId: "p4" } }, legacyRef: null },
    );
    const own = [
      doc({ id: "p1", kind: "OTHER", title: "Business", body: "We are a salon." }),
      doc({ id: "p3", kind: "FAQ", title: "Open on Friday?", body: "Yes." }),
      doc({ id: "p4", kind: "POLICY", title: "Old policy", body: "Being deleted by the publisher right now." }),
    ];
    const legacy = await w.deps.kewyDocs(A);
    w.deps.kewyDocs.mockImplementation(async (ws: string) => (ws === A ? [...legacy, ...own] : []));
    const before = w.db.knowledgeSource.length;

    const first = await migrateIn(w.deps, { workspaceIds: [A], dryRun: false });
    expect(first).toMatchObject({ faq: 1, file: 1, guidelines: 2, publishedSkipped: 3 });
    for (const id of ["p1", "p3", "p4"]) expect(w.db.knowledgeSource.some((s) => s.legacyRef === `kewy:${id}`)).toBe(false);
    // Pre-existing legacy docs still migrate.
    expect(w.db.knowledgeSource.find((s) => s.legacyRef === "kewy:k2")).toMatchObject({ kind: "file", upstream: { kewy: { docId: "k2" } } });
    // No two sources share a kewy doc id.
    const ids = w.db.knowledgeSource.map((s) => s.upstream?.kewy?.docId).filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
    const after = w.db.knowledgeSource.length;
    expect(after).toBeGreaterThan(before);

    // Rerun: idempotent.
    const second = await migrateIn(w.deps, { workspaceIds: [A], dryRun: false });
    expect(second).toMatchObject({ faq: 0, file: 0, guidelines: 0, lDocuments: 0, publishedSkipped: 3 });
    expect(w.db.knowledgeSource).toHaveLength(after);
  });

  it("a TONE doc the guidelines published is not appended back into them", async () => {
    const w = setup();
    w.db.knowledgeSource.push({ id: "own_g", workspaceId: A, kind: "guideline", status: "ready", title: "Guidelines", body: "Be brief.", upstream: { kewy: { docId: "p2" } }, legacyRef: null, version: 3 });
    w.deps.kewyDocs.mockImplementation(async (ws: string) => (ws === A ? [doc({ id: "p2", kind: "TONE", title: "Guidelines", body: "Be brief." })] : []));
    const r = await migrateIn(w.deps, { workspaceIds: [A], dryRun: false });
    expect(r).toMatchObject({ guidelines: 0, publishedSkipped: 1 });
    expect(w.db.knowledgeSource.find((s) => s.id === "own_g")).toMatchObject({ body: "Be brief.", version: 3, upstream: { kewy: { docId: "p2" } } });
  });
});
