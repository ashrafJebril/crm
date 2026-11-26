/* eslint-disable @typescript-eslint/no-explicit-any */
import { HttpException } from "@nestjs/common";
import { moveKnowledgeToL, type MoveRow } from "./knowledge-move";
import { crmTemplate } from "./l-knowledge";

const row = (over: Partial<MoveRow>): MoveRow => ({
  id: "s", kind: "faq", title: "t", bodyJson: null, body: null, question: null, order: 0, typedKind: null,
  url: null, scope: null, schedule: null, legacyRef: null, media: null, ...over,
});
const media = (fileName: string, sizeBytes = 3) => ({ fileName, mimeType: "application/pdf", sizeBytes, storageKind: "local", storedPath: `k/${fileName}` });
const conflict = (message: string) => new HttpException({ statusCode: 409, message }, 409);

function world(rows: MoveRow[], lFiles: { fileName: string; sizeBytes: number }[] = []) {
  const calls: { path: string; method: string; body?: any; form?: FormData }[] = [];
  const deps = {
    workspaces: jest.fn(async () => [{ id: "wsA", lWorkspaceId: "lA", timezone: "Asia/Riyadh" }]),
    sources: jest.fn(async () => rows),
    l: jest.fn(async (path: string, o: any = {}) => {
      calls.push({ path, method: o.method ?? "GET", body: o.body, form: o.formData });
      if (path === "/workspaces/lA/knowledge/sources") return { items: lFiles.map((f) => ({ kind: "file", title: f.fileName, file: f })) };
      if (path.endsWith("/sources?kind=content")) return { items: [{ version: 4 }] };
      if (path.includes("/guidelines?agent=")) return null;
      if (path.endsWith("/faqs") && o.body.question === "Dup?") throw conflict("knowledge.faq_duplicate");
      if (path.endsWith("/websites") && o.body.url === "https://old.example/") throw conflict("knowledge.website_exists");
      if (path.endsWith("/websites") && o.body.url === "https://bad.example/") throw new HttpException({ statusCode: 400, message: "knowledge.url_blocked" }, 400);
      return {};
    }),
    agentSlug: jest.fn(async () => "agent-a"),
    readFile: jest.fn(async (m: any) => Buffer.from(`bytes ${m.fileName}`)),
    dropGuidelinesBlock: jest.fn(async () => "updated"),
    log: jest.fn(),
  };
  return { deps, calls };
}

const ROWS = [
  row({ id: "w1", kind: "website", url: "https://salon.example/", scope: "site", schedule: "daily" }),
  row({ id: "w2", kind: "website", url: "https://old.example/" }),
  row({ id: "w3", kind: "website", url: "https://bad.example/" }),
  row({ id: "f2", kind: "faq", question: "Second?", body: "B", order: 2 }),
  row({ id: "f1", kind: "faq", question: "First?", body: "A", order: 1 }),
  row({ id: "f3", kind: "faq", question: "Dup?", body: "C", order: 3 }),
  row({ id: "c", kind: "content", bodyJson: { type: "doc", content: [] } }),
  row({ id: "g", kind: "guideline", body: "Be kind." }),
  row({ id: "p", kind: "file", title: "menu.pdf", media: media("menu.pdf") }),
  row({ id: "seen", kind: "file", title: "old.pdf", media: media("old.pdf", 9) }),
  row({ id: "o", kind: "typed_doc", typedKind: "offers", media: media("offers.xlsx") }),
  row({ id: "fromL", kind: "file", legacyRef: "l:doc1" }),
  row({ id: "fromKewy", kind: "file", legacyRef: "kewy:k1" }),
];

describe("moving knowledge to l", () => {
  it("a dry run writes nothing and says what it would copy", async () => {
    const { deps, calls } = world(ROWS);
    const counts = await moveKnowledgeToL(deps as never, { workspaceIds: "all", dryRun: true });
    expect(calls).toEqual([]);
    expect(counts).toEqual({ workspaces: 1, content: 1, faq: 3, guidelines: 1, file: 2, typed_doc: 1, website: 3, alreadyInL: 1, kewyCopies: 1, failed: 0 });
  });

  it("copies each kind to the workspace's l workspace, and skips what l has", async () => {
    const { deps, calls } = world(ROWS, [{ fileName: "old.pdf", sizeBytes: 9 }]);
    const counts = await moveKnowledgeToL(deps as never, { workspaceIds: ["wsA"], dryRun: false });
    expect(counts).toEqual({ workspaces: 1, content: 1, faq: 2, guidelines: 1, file: 1, typed_doc: 1, website: 1, alreadyInL: 4, kewyCopies: 1, failed: 1 });
    const writes = calls.filter((c) => c.method !== "GET");
    expect(writes[0]).toEqual({ path: "/workspaces/lA", method: "PATCH", body: { timezone: "Asia/Riyadh" }, form: undefined });
    // Content first (over l's current version), FAQs in their order, then guidelines.
    expect(writes.slice(1, 6).map((c) => [c.path.replace("/workspaces/lA/knowledge", ""), c.body?.question ?? c.body?.version])).toEqual([
      ["/content", 4],
      ["/faqs", "First?"],
      ["/faqs", "Second?"],
      ["/faqs", "Dup?"],
      ["/guidelines", 0],
    ]);
    expect(writes[5].body).toEqual({ agent: "agent-a", body: "Be kind.", version: 0 });
    expect(deps.dropGuidelinesBlock).toHaveBeenCalledWith("wsA");
    // Files: the stored bytes; the one l already lists is not sent again; offers with crm's template.
    const uploads = writes.filter((c) => c.path.endsWith("/files"));
    expect(uploads.map((u) => (u.form!.get("files") as File).name)).toEqual(["menu.pdf", "offers.xlsx"]);
    expect(JSON.parse(String(uploads[1].form!.get("template")))).toEqual(crmTemplate("offers"));
    expect(uploads[1].form!.get("acceptValidRows")).toBe("true");
    expect(writes.find((c) => c.path.endsWith("/websites"))!.body).toEqual({ url: "https://salon.example/", scope: "site", schedule: "daily" });
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("FAILED knowledge.url_blocked"));
  });
});
