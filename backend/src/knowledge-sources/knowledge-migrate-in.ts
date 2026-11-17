/**
 * SP-21 (ruling 3) migrate-in: existing knowledge appears as sources.
 * Rerunnable (keyed by `legacyRef`, unique per workspace), dry-run by default,
 * and it never deletes or changes anything upstream.
 *
 *  - kewy-ai documents, editable ones only (HJZ-synced docs, `editable:
 *    false`, stay managed by the product sync and are never migrated):
 *      FAQ → one `faq` source (question = doc title, answer = body);
 *      TONE → appended to the guidelines (the guideline row records the
 *        doc ids it took, so a rerun appends nothing twice);
 *      POLICY / SERVICE_DESCRIPTION / PROMOTION / OTHER → a `file` source
 *        with no stored file, holding the text as chunks.
 *    Each keeps `upstream.kewy.docId`, so the publisher updates that same
 *    document instead of creating a duplicate.
 *    A doc whose id is already some source's `upstream.kewy.docId` in the
 *    workspace is SP-21's own published copy (or one a tombstone is still
 *    deleting): it is skipped (`publishedSkipped`), else two sources would
 *    share one doc and deleting either would delete it for both.
 *  - l documents → `file` sources with the status mirrored and no text (l
 *    does not give the text back; the UI asks for a re-upload to search them).
 *
 * The caller passes an unscoped Prisma client (a script, not a request).
 */
import { chunkText } from "./knowledge-chunker";
import { chunkRowsFor } from "./knowledge-processor";
import { FAQ_ANSWER_MAX, FAQ_QUESTION_MAX, GUIDELINES_MAX } from "./knowledge-constants";
import type { KewyKnowledgeDoc } from "../knowledge/knowledge.client";
import type { LDocument } from "../integrations/l-knowledge.service";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = {
  knowledgeSource: { findFirst(a: any): Promise<any>; findMany(a: any): Promise<any[]>; create(a: any): Promise<any>; update(a: any): Promise<any> };
  knowledgeChunk: { createMany(a: any): Promise<any> };
  workspace: { findMany(a: any): Promise<{ id: string; lWorkspaceId: string | null; externalTenantId: string | null }[]> };
};

export interface MigrateInDeps {
  db: Db;
  /** kewy-ai documents of a workspace; absent when kewy-ai is not configured. */
  kewyDocs?: (workspaceId: string) => Promise<KewyKnowledgeDoc[]>;
  /** l documents of a workspace; absent when l is not configured. */
  lDocs?: (workspaceId: string) => Promise<LDocument[]>;
  log?: (line: string) => void;
}

export interface MigrateInCounts {
  workspaces: number;
  faq: number;
  file: number;
  guidelines: number;
  lDocuments: number;
  existing: number;
  hjzSyncedSkipped: number;
  tooLongSkipped: number;
  /** kewy-ai docs that are SP-21's own published copies. */
  publishedSkipped: number;
}

const TITLE_MAX = 200;

const READY_L = new Set(["ready", "processed", "completed", "indexed", "done"]);

export async function migrateIn(deps: MigrateInDeps, opts: { workspaceIds: string[] | "all"; dryRun: boolean }): Promise<MigrateInCounts> {
  const counts: MigrateInCounts = { workspaces: 0, faq: 0, file: 0, guidelines: 0, lDocuments: 0, existing: 0, hjzSyncedSkipped: 0, tooLongSkipped: 0, publishedSkipped: 0 };
  const workspaces = await deps.db.workspace.findMany({
    where: opts.workspaceIds === "all" ? {} : { id: { in: opts.workspaceIds } },
    select: { id: true, lWorkspaceId: true, externalTenantId: true },
  });
  for (const ws of workspaces) {
    counts.workspaces += 1;
    if (deps.kewyDocs) await migrateKewy(deps, ws.id, opts.dryRun, counts);
    if (deps.lDocs && ws.lWorkspaceId) await migrateL(deps, ws.id, opts.dryRun, counts);
  }
  deps.log?.(`${opts.dryRun ? "[dry-run] would create" : "created"}: ${JSON.stringify(counts)}`);
  return counts;
}

async function exists(db: Db, workspaceId: string, legacyRef: string): Promise<boolean> {
  return !!(await db.knowledgeSource.findFirst({ where: { workspaceId, legacyRef }, select: { id: true } }));
}

async function create(db: Db, data: Record<string, unknown>, text: string | null): Promise<boolean> {
  try {
    const row = await db.knowledgeSource.create({ data });
    const chunks = text ? chunkText(text) : [];
    if (chunks.length) await db.knowledgeChunk.createMany({ data: chunkRowsFor(String(data.workspaceId), row.id, chunks) });
    return true;
  } catch (e) {
    // A concurrent run created it first: the unique (workspaceId, legacyRef) holds.
    if ((e as { code?: string })?.code === "P2002") return false;
    throw e;
  }
}

/** Every kewy-ai doc id a source of the workspace already holds (tombstones included). */
async function heldDocIds(db: Db, workspaceId: string): Promise<Set<string>> {
  const rows = await db.knowledgeSource.findMany({ where: { workspaceId }, select: { upstream: true } });
  const ids = new Set<string>();
  for (const r of rows) {
    const id = (r.upstream as { kewy?: { docId?: unknown } } | null)?.kewy?.docId;
    if (typeof id === "string" && id) ids.add(id);
  }
  return ids;
}

async function migrateKewy(deps: MigrateInDeps, workspaceId: string, dryRun: boolean, counts: MigrateInCounts) {
  const docs = await deps.kewyDocs!(workspaceId);
  const held = await heldDocIds(deps.db, workspaceId);
  const tone: KewyKnowledgeDoc[] = [];
  for (const doc of docs) {
    if (!doc.editable || doc.sourceRef) {
      counts.hjzSyncedSkipped += 1;
      continue;
    }
    if (doc.kind === "TONE") {
      tone.push(doc);
      continue;
    }
    const legacyRef = `kewy:${doc.id}`;
    if (await exists(deps.db, workspaceId, legacyRef)) {
      counts.existing += 1;
      continue;
    }
    if (held.has(doc.id)) {
      counts.publishedSkipped += 1;
      continue;
    }
    const upstream = { kewy: { docId: doc.id } };
    if (doc.kind === "FAQ") {
      const question = doc.title.trim().slice(0, FAQ_QUESTION_MAX);
      const answer = doc.body.trim();
      if (!question || !answer || answer.length > FAQ_ANSWER_MAX) {
        counts.tooLongSkipped += 1;
        continue;
      }
      if (!dryRun) {
        const ok = await create(
          deps.db,
          { workspaceId, kind: "faq", status: "ready", title: question.slice(0, TITLE_MAX), question, body: answer, itemCount: 1, legacyRef, upstream, publishState: "published" },
          `${question}\n${answer}`,
        );
        if (!ok) continue;
      }
      counts.faq += 1;
      continue;
    }
    const text = doc.body.trim();
    if (!dryRun) {
      const ok = await create(
        deps.db,
        { workspaceId, kind: "file", status: text ? "ready" : "failed", error: text ? null : "knowledge.empty", title: doc.title.slice(0, TITLE_MAX) || "Document", legacyRef, upstream, publishState: "published" },
        text,
      );
      if (!ok) continue;
    }
    counts.file += 1;
  }
  if (tone.length) await migrateTone(deps, workspaceId, tone, held, dryRun, counts);
}

/** TONE docs are appended to the guidelines singleton, each once. */
async function migrateTone(deps: MigrateInDeps, workspaceId: string, docs: KewyKnowledgeDoc[], held: Set<string>, dryRun: boolean, counts: MigrateInCounts) {
  const row = await deps.db.knowledgeSource.findFirst({ where: { workspaceId, kind: "guideline" } });
  const upstream = (row?.upstream as { kewyTone?: string[]; kewy?: { docId: string } } | null) ?? {};
  const taken = new Set(upstream.kewyTone ?? []);
  const notTaken = docs.filter((d) => !taken.has(d.id));
  counts.existing += docs.length - notTaken.length;
  // The guidelines' own published TONE copy is never appended back into them.
  const fresh = notTaken.filter((d) => !held.has(d.id));
  counts.publishedSkipped += notTaken.length - fresh.length;
  if (!fresh.length) return;
  let body = String(row?.body ?? "").trim();
  const added: string[] = [];
  for (const d of fresh) {
    const next = [body, d.body.trim()].filter(Boolean).join("\n\n");
    if (next.length > GUIDELINES_MAX) {
      counts.tooLongSkipped += 1;
      continue;
    }
    body = next;
    added.push(d.id);
  }
  if (!added.length) return;
  counts.guidelines += added.length;
  if (dryRun) return;
  // The guidelines publish reuses the first migrated TONE doc's id, so the next
  // guidelines save updates that doc in place instead of creating a second TONE
  // doc. Any further TONE docs stay upstream as they were: this never deletes.
  const nextUpstream = { ...upstream, kewyTone: [...taken, ...added], ...(upstream.kewy?.docId ? {} : { kewy: { docId: added[0] } }) };
  if (row) {
    await deps.db.knowledgeSource.update({ where: { id: row.id }, data: { body, upstream: nextUpstream, version: { increment: 1 } } });
  } else {
    await deps.db.knowledgeSource.create({
      data: { workspaceId, kind: "guideline", status: "ready", title: "Guidelines", body, upstream: nextUpstream, version: 1 },
    });
  }
}

async function migrateL(deps: MigrateInDeps, workspaceId: string, dryRun: boolean, counts: MigrateInCounts) {
  const docs = await deps.lDocs!(workspaceId);
  for (const doc of docs) {
    const legacyRef = `l:${doc.id}`;
    if (await exists(deps.db, workspaceId, legacyRef)) {
      counts.existing += 1;
      continue;
    }
    const ready = READY_L.has(String(doc.status ?? "").toLowerCase());
    if (!dryRun) {
      const ok = await create(
        deps.db,
        {
          workspaceId,
          kind: "file",
          status: ready ? "ready" : "failed",
          error: ready ? null : "knowledge.unreadable",
          title: String(doc.title ?? "Document").slice(0, TITLE_MAX),
          legacyRef,
          upstream: { l: { documentId: doc.id } },
        },
        null,
      );
      if (!ok) continue;
    }
    counts.lDocuments += 1;
  }
}
