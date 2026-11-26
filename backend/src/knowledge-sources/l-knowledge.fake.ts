/* eslint-disable @typescript-eslint/no-explicit-any */
import { HttpException } from "@nestjs/common";
import { makeFakePrisma } from "../channels/test-prisma";
import { KnowledgeSearchService } from "./knowledge-search.service";
import { KnowledgeSourcesService } from "./knowledge-sources.service";
import { agentOff, type LTarget } from "./l-knowledge";
import { WebsitesService } from "./website/websites.service";

/**
 * Test world: crm's knowledge services over an in-memory stand-in for l's
 * joteck knowledge API. `db.knowledgeSource` holds l documents (l kinds),
 * `db.knowledgePage` and `db.knowledgeChunk` what l read from them.
 * Workspace A has an l workspace; B has its AI agent off.
 */
export const A = "wsA";
export const B = "wsB";

const lErr = (status: number, message: string, extra: Record<string, unknown> = {}) =>
  new HttpException({ statusCode: status, message, ...extra }, status);

/** Plain text of a TipTap doc: each block's text on its own line. */
function docText(node: any): string {
  if (!node || typeof node !== "object") return "";
  if (typeof node.text === "string") return node.text;
  const parts = Array.isArray(node.content) ? node.content.map(docText) : [];
  return node.type === "doc" ? parts.filter(Boolean).join("\n") : parts.join("");
}

export function knowledgeWorld() {
  const prisma = makeFakePrisma({
    workspace: [
      { id: A, name: "A", slug: "a", timezone: "Asia/Riyadh", lWorkspaceId: "lA", lAgentSlug: "agent-a" },
      { id: B, name: "B", slug: "b", timezone: "Asia/Riyadh", lWorkspaceId: null },
    ],
    user: [{ id: "uOwner", name: "Owner A" }, { id: "uOther", name: "Owner B" }],
    workspaceMember: [
      { id: "m1", workspaceId: A, userId: "uOwner", role: "owner" },
      { id: "m3", workspaceId: B, userId: "uOther", role: "owner" },
    ],
  }) as any;
  const db = prisma.db;
  db.knowledgeSource = [];
  db.knowledgePage = [];
  db.knowledgeChunk = [];
  let seq = 0;
  const now = () => new Date().toISOString();

  const dto = (s: any) => {
    const out: any = { error: null, order: 0, template: null, agent: null, url: null, scope: null, schedule: null, lastSyncAt: null, nextSyncAt: null, consecutiveFailures: 0, syncing: false, lastRun: null, itemCount: 0, version: 0, file: null, createdAt: now(), updatedAt: now(), ...s };
    if (s.kind === "website") {
      const counts: Record<string, number> = {};
      for (const p of db.knowledgePage.filter((p: any) => p.sourceId === s.id)) counts[p.state] = (counts[p.state] ?? 0) + 1;
      out.pageCounts = counts;
    }
    return out;
  };
  const find = (ws: string, id: string) => {
    const s = db.knowledgeSource.find((r: any) => r.workspaceId === ws && r.id === id);
    if (!s) throw lErr(404, "knowledge.not_found");
    return s;
  };
  const add = (ws: string, row: any) => {
    const s = { id: `src-${++seq}`, workspaceId: ws, status: "ready", ...row };
    db.knowledgeSource.push(s);
    return s;
  };

  /** One l call: `${base}${path}`, routed like l's API. */
  const handle = (ws: string, method: string, path: string, body: any, form?: FormData): any => {
    const [p, qs] = path.split("?");
    const q = new URLSearchParams(qs ?? "");
    const parts = p.split("/").filter(Boolean);
    const mine = () => db.knowledgeSource.filter((s: any) => s.workspaceId === ws);
    if (method === "GET" && p === "/sources") {
      return { items: mine().filter((s: any) => (!q.get("kind") || s.kind === q.get("kind")) && (!q.get("status") || s.status === q.get("status"))).map(dto) };
    }
    if (parts[0] === "sources" && parts.length >= 2) {
      const s = find(ws, decodeURIComponent(parts[1]));
      if (method === "GET" && parts.length === 2) return dto(s);
      if (method === "DELETE") {
        db.knowledgeSource = db.knowledgeSource.filter((r: any) => r !== s);
        return { ok: true };
      }
      if (parts[2] === "preview") {
        const chunks = db.knowledgeChunk.filter((c: any) => c.sourceId === s.id).sort((a: any, b: any) => a.ord - b.ord);
        const groups: any[] = [];
        for (const c of chunks) {
          const page = db.knowledgePage.find((pg: any) => pg.id === c.pageId);
          let g = groups.find((x) => x.heading === (c.heading ?? null));
          if (!g) groups.push((g = { heading: c.heading ?? null, items: [] }));
          g.items.push({ chunkId: c.id, text: c.text, rowRef: null, url: page?.url ?? null });
        }
        return { sourceId: s.id, groups, truncated: false };
      }
      if (parts[2] === "reprocess") return dto({ ...s, status: "queued" });
    }
    if (method === "PUT" && p === "/content") {
      const cur = mine().find((s: any) => s.kind === "content");
      if ((cur?.version ?? 0) !== body.version) throw lErr(409, "knowledge.version_conflict", { current: cur ? dto(cur) : null });
      const text = docText(body.bodyJson);
      if (!cur) return dto(add(ws, { kind: "content", title: "Business content", bodyJson: body.bodyJson, body: text, version: 1 }));
      Object.assign(cur, { bodyJson: body.bodyJson, body: text, version: cur.version + 1 });
      return dto(cur);
    }
    if (p === "/guidelines") {
      const cur = mine().find((s: any) => s.kind === "guidelines" && s.agent === (body?.agent ?? q.get("agent")));
      if (method === "GET") return cur ? dto(cur) : null;
      if ((cur?.version ?? 0) !== body.version) throw lErr(409, "knowledge.version_conflict");
      if (!cur) return dto(add(ws, { kind: "guidelines", title: "Guidelines", agent: body.agent, body: body.body, version: 1 }));
      Object.assign(cur, { body: body.body, version: cur.version + 1 });
      return dto(cur);
    }
    if (method === "POST" && p === "/faqs") {
      const key = (t: string) => t.trim().toLowerCase().replace(/\s+/g, " ");
      if (mine().some((s: any) => s.kind === "faq" && key(s.question) === key(body.question))) throw lErr(400, "knowledge.faq_duplicate");
      return dto(add(ws, { kind: "faq", title: body.question, question: body.question, body: body.answer, version: 1 }));
    }
    if (method === "POST" && p === "/files") {
      const files = form!.getAll("files") as File[];
      const template = form!.get("template");
      const tid = template ? JSON.parse(String(template)).id : null;
      return { items: files.map((f) => dto(add(ws, { kind: tid ? "sheet" : "file", template: tid, title: f.name, status: "queued", file: { fileName: f.name, mimeType: f.type, sizeBytes: f.size } }))) };
    }
    if (method === "POST" && p === "/websites") {
      if (mine().some((s: any) => s.kind === "website" && s.url === body.url)) throw lErr(409, "knowledge.website_exists");
      return dto(add(ws, { kind: "website", title: body.url, url: body.url, scope: body.scope ?? "site", schedule: body.schedule ?? "weekly", status: "queued" }));
    }
    if (method === "POST" && p === "/websites/check") return { ok: true, normalizedUrl: body.url, host: new URL(body.url).host, robotsAllowed: true, sitemapPages: null };
    if (method === "POST" && p === "/search") {
      const ready = new Set(mine().filter((s: any) => s.status === "ready" && s.kind !== "guidelines" && (!body.template || s.template === body.template)).map((s: any) => s.id));
      const words = String(body.q).toLowerCase().split(/\s+/);
      return {
        items: db.knowledgeChunk
          .filter((c: any) => ready.has(c.sourceId) && words.some((w) => c.text.toLowerCase().includes(w)))
          .slice(0, body.limit)
          .map((c: any) => {
            const s = db.knowledgeSource.find((r: any) => r.id === c.sourceId);
            return { chunkId: c.id, sourceId: s.id, sourceTitle: s.title, kind: s.kind, heading: c.heading ?? null, text: c.text };
          }),
      };
    }
    throw new Error(`fake l: no route for ${method} ${path}`);
  };

  const calls: { ws: string; method: string; path: string; body?: unknown; form?: FormData }[] = [];
  const wsOf = (t: LTarget) => db.workspace.find((w: any) => w.lWorkspaceId === t.lWorkspaceId).id as string;
  const l = {
    target: jest.fn(async (workspaceId: string): Promise<LTarget | null> => {
      const w = db.workspace.find((x: any) => x.id === workspaceId);
      return w?.lWorkspaceId ? { lWorkspaceId: w.lWorkspaceId, base: `/workspaces/${w.lWorkspaceId}/knowledge` } : null;
    }),
    async require(workspaceId: string) {
      const t = await l.target(workspaceId);
      if (!t) throw agentOff();
      return t;
    },
    agentSlug: async (workspaceId: string) => db.workspace.find((x: any) => x.id === workspaceId).lAgentSlug as string,
    call: jest.fn(async (t: LTarget, path: string, opts: { method?: string; body?: unknown; formData?: FormData } = {}) => {
      const ws = wsOf(t);
      const method = opts.method ?? "GET";
      calls.push({ ws, method, path, body: opts.body, form: opts.formData });
      return handle(ws, method, path, opts.body, opts.formData);
    }),
    raw: jest.fn(async (t: LTarget, path: string) => {
      const s = find(wsOf(t), decodeURIComponent(path.split("/")[2]));
      return { data: Buffer.from(`bytes of ${s.title}`), contentType: s.file?.mimeType ?? null, disposition: `inline; filename="${s.title}"` };
    }),
  };

  const svc = new KnowledgeSourcesService(l as never);
  const search = new KnowledgeSearchService(l as never);
  const websites = new WebsitesService(l as never);
  return { prisma, db, l, calls, svc, search, websites };
}

/** The status and body of a rejected HttpException. */
export async function failure(p: Promise<unknown>): Promise<{ status: number; body: unknown }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpException) return { status: e.getStatus(), body: e.getResponse() };
    throw e;
  }
  throw new Error("expected a failure");
}
