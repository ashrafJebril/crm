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
    const rows = w.db.knowledgeSource.length;

    // Second run: nothing new, nothing appended twice.
    const second = await migrateIn(w.deps, { workspaceIds: [A], dryRun: false });
    expect(second).toMatchObject({ faq: 0, file: 0, guidelines: 0, lDocuments: 0, existing: 6 });
    expect(w.db.knowledgeSource).toHaveLength(rows);
    expect(w.db.knowledgeSource.find((s) => s.kind === "guideline").body).toBe(g.body);
    // Upstream is only read, never changed or deleted.
    expect(Object.keys(w.deps).sort()).toEqual(["db", "kewyDocs", "lDocs"]);
  });

  it("hjz synced docs are never migrated", async () => {
    const w = setup();
    await migrateIn(w.deps, { workspaceIds: [A], dryRun: false });
    expect(w.db.knowledgeSource.some((s) => s.legacyRef === "kewy:h1")).toBe(false);
    expect(w.db.knowledgeSource.some((s) => s.title === "Haircut")).toBe(false);
  });
});
