/**
 * One-off: copy each workspace's knowledge from crm's own tables to l, where
 * it now lives (scripts/knowledge-move-to-l.ts runs it).
 *
 * Dry run by default. Rerunnable: content and guidelines are written over
 * (same text), an FAQ or website l already has is skipped (l refuses the
 * duplicate), and a file l already lists under the same name and size is
 * skipped. Never deletes anything in crm. Per kind:
 *  - content, FAQ (in their order), guidelines (the workspace agent's; its
 *    old copy in the agent prompt is removed, l adds them itself now)
 *  - files and typed documents: the stored bytes, typed ones with crm's template
 *  - websites: url, scope and schedule (l reads the site again)
 *  - rows that came from l ("l:" legacyRef) are already there; rows copied in
 *    from kewy-ai ("kewy:") have no file and stay in kewy-ai for now (counted).
 * The l workspace also gets crm's timezone (offers expire by it).
 */
import { crmTemplate, isTypedKind } from "./l-knowledge";

export interface KnowledgeMoveCounts {
  workspaces: number;
  content: number;
  faq: number;
  guidelines: number;
  file: number;
  typed_doc: number;
  website: number;
  /** Already on l (came from l, or l had the same FAQ, website or file). */
  alreadyInL: number;
  /** Copied in from kewy-ai, with no file of their own: left there for now. */
  kewyCopies: number;
  failed: number;
}

export interface MoveRow {
  id: string;
  kind: string;
  title: string;
  bodyJson: unknown;
  body: string | null;
  question: string | null;
  order: number;
  typedKind: string | null;
  url: string | null;
  scope: string | null;
  schedule: string | null;
  legacyRef: string | null;
  media: { fileName: string; mimeType: string; sizeBytes: number; storageKind: string; storedPath: string } | null;
}

export interface MoveWorkspace {
  id: string;
  lWorkspaceId: string;
  timezone: string | null;
}

export interface MoveDeps {
  workspaces: (ids: string[] | "all") => Promise<MoveWorkspace[]>;
  sources: (workspaceId: string) => Promise<MoveRow[]>;
  /** An l joteck call (path after /api/v1/joteck). */
  l: <T>(path: string, opts?: { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown; formData?: FormData; timeoutMs?: number }) => Promise<T>;
  agentSlug: (workspaceId: string, lWorkspaceId: string) => Promise<string>;
  readFile: (media: NonNullable<MoveRow["media"]>) => Promise<Buffer>;
  /** Remove the old guidelines block from the l agent's prompt. */
  dropGuidelinesBlock: (workspaceId: string) => Promise<unknown>;
  log: (line: string) => void;
}

const errKey = (e: unknown): string | undefined => {
  const r = (e as { getResponse?: () => unknown })?.getResponse?.();
  return r && typeof r === "object" ? ((r as { message?: string }).message ?? undefined) : undefined;
};

const ORDER = ["content", "faq", "guideline", "file", "typed_doc", "website"];

export async function moveKnowledgeToL(deps: MoveDeps, opts: { workspaceIds: string[] | "all"; dryRun: boolean }): Promise<KnowledgeMoveCounts> {
  const counts: KnowledgeMoveCounts = { workspaces: 0, content: 0, faq: 0, guidelines: 0, file: 0, typed_doc: 0, website: 0, alreadyInL: 0, kewyCopies: 0, failed: 0 };
  for (const ws of await deps.workspaces(opts.workspaceIds)) {
    counts.workspaces += 1;
    const base = `/workspaces/${encodeURIComponent(ws.lWorkspaceId)}`;
    const k = `${base}/knowledge`;
    const rows = (await deps.sources(ws.id)).sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || a.order - b.order);
    deps.log(`workspace ${ws.id} → l ${ws.lWorkspaceId}: ${rows.length} sources`);
    if (!opts.dryRun && ws.timezone) await deps.l(base, { method: "PATCH", body: { timezone: ws.timezone } });
    const existingFiles = opts.dryRun
      ? []
      : (await deps.l<{ items: { kind: string; title: string; file: { fileName: string; sizeBytes: number } | null }[] }>(`${k}/sources`)).items.filter((s) => s.file);
    for (const row of rows) {
      const tag = `  ${row.kind} ${row.id} "${row.title.slice(0, 60)}"`;
      if (row.legacyRef?.startsWith("l:")) {
        counts.alreadyInL += 1;
        continue;
      }
      if ((row.kind === "file" || row.kind === "typed_doc") && !row.media) {
        if (row.legacyRef?.startsWith("kewy:")) counts.kewyCopies += 1;
        else {
          counts.failed += 1;
          deps.log(`${tag}: no stored file, skipped`);
        }
        continue;
      }
      if (opts.dryRun) {
        deps.log(`${tag}: would copy`);
        bump(counts, row.kind);
        continue;
      }
      try {
        const done = await moveOne(deps, ws, k, row, existingFiles);
        if (done) bump(counts, row.kind);
        deps.log(`${tag}: ${done ? "copied" : "already in l"}`);
        if (!done) counts.alreadyInL += 1;
      } catch (e) {
        counts.failed += 1;
        deps.log(`${tag}: FAILED ${errKey(e) ?? (e instanceof Error ? e.message : String(e))}`);
      }
    }
  }
  return counts;
}

function bump(c: KnowledgeMoveCounts, kind: string) {
  if (kind === "guideline") c.guidelines += 1;
  else if (kind in c) (c as unknown as Record<string, number>)[kind] += 1;
}

/** True when copied, false when l already had it. */
async function moveOne(
  deps: MoveDeps,
  ws: MoveWorkspace,
  k: string,
  row: MoveRow,
  existingFiles: { title: string; file: { fileName: string; sizeBytes: number } | null }[],
): Promise<boolean> {
  switch (row.kind) {
    case "content": {
      const cur = (await deps.l<{ items: { version: number }[] }>(`${k}/sources?kind=content`)).items[0];
      await deps.l(`${k}/content`, { method: "PUT", body: { bodyJson: row.bodyJson, version: cur?.version ?? 0 } });
      return true;
    }
    case "faq":
      try {
        await deps.l(`${k}/faqs`, { method: "POST", body: { question: row.question ?? row.title, answer: row.body ?? "" } });
        return true;
      } catch (e) {
        if (errKey(e) === "knowledge.faq_duplicate") return false;
        throw e;
      }
    case "guideline": {
      const agent = await deps.agentSlug(ws.id, ws.lWorkspaceId);
      const cur = await deps.l<{ version: number } | null>(`${k}/guidelines?agent=${encodeURIComponent(agent)}`);
      await deps.l(`${k}/guidelines`, { method: "PUT", body: { agent, body: row.body ?? "", version: cur?.version ?? 0 } });
      await deps.dropGuidelinesBlock(ws.id);
      return true;
    }
    case "file":
    case "typed_doc": {
      const m = row.media!;
      if (existingFiles.some((s) => s.file?.fileName === m.fileName && s.file.sizeBytes === m.sizeBytes)) return false;
      const fd = new FormData();
      fd.append("files", new Blob([new Uint8Array(await deps.readFile(m))], { type: m.mimeType }), m.fileName);
      if (row.kind === "typed_doc" && isTypedKind(row.typedKind)) {
        fd.append("template", JSON.stringify(crmTemplate(row.typedKind)));
        // It was accepted before, so its valid rows are kept again.
        fd.append("acceptValidRows", "true");
      }
      await deps.l(`${k}/files`, { method: "POST", formData: fd, timeoutMs: 120_000 });
      return true;
    }
    case "website":
      try {
        await deps.l(`${k}/websites`, { method: "POST", body: { url: row.url, scope: row.scope ?? "site", schedule: row.schedule ?? "weekly" }, timeoutMs: 30_000 });
        return true;
      } catch (e) {
        if (errKey(e) === "knowledge.website_exists") return false;
        throw e;
      }
    default:
      return false;
  }
}
