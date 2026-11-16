/**
 * SP-21 publishing (ruling 2, ruling 11). After-commit, never fails a save.
 *
 *  - l agent (workspace has `lWorkspaceId`): nothing is copied; the agent
 *    reads through `search_knowledge`. Only the guidelines go into its live
 *    prompt, as the bounded block `kewy-crm-guidelines` (one PUT per change;
 *    an empty guideline removes the block).
 *  - kewy-ai (see `target()` for the gate): content (`OTHER`), each FAQ
 *    (`FAQ`, title = question), the guidelines (`TONE`), and every file,
 *    typed document and website as one `OTHER` document of its chunk text
 *    (≤ KEWY_DOC_MAX chars; longer → truncated and recorded). The upstream id
 *    is kept in `upstream.kewy.docId` and reused, so an edit updates the same
 *    document. Migrated guidelines carry the first migrated TONE doc's id, so
 *    they update that doc in place.
 *
 * Ordering (review fix):
 *  - In process, every publish and unpublish of one source runs strictly in
 *    order on a per-source promise chain.
 *  - Across processes, the final write is a compare-and-set on the row's
 *    `version` and `updatedAt` as read at the start, and records the content
 *    version it published (`upstream.publishedVersion`). A publish that lost
 *    the race re-reads and publishes again (at most PUBLISH_CAS_ROUNDS), so an
 *    older publish finishing last never leaves older content upstream. A doc it
 *    created that someone else's record supersedes is deleted; when the source
 *    was deleted meanwhile, the doc it just created is deleted.
 *
 * Failures: `schedule(id)` marks `publishState: "pending"`; a failure leaves
 * `failed` with `upstream.publish.attempts` (only the error class is logged).
 * The retry sweep backs off exponentially (publishBackoffMs: 1, 2, 4 … 60 min)
 * and stops after PUBLISH_MAX_ATTEMPTS until the next save, which counts
 * afresh.
 *
 * Delete removes the kewy-ai doc, the l guidelines block and (for a migrated
 * legacy source, `upstream.l.documentId`) the l document: explicit deletion
 * means the content is gone everywhere. Whatever could not be removed is kept
 * as a hidden TOMBSTONE_KIND row that the same sweep retries with the same
 * backoff. (The migrate-in script itself never deletes upstream.)
 */
import { Injectable, Logger, Optional } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { LAgentSetupService } from "../integrations/l-agent-setup.service";
import { LKnowledgeService } from "../integrations/l-knowledge.service";
import { KnowledgeClient, type KewyKnowledgeKind } from "../knowledge/knowledge.client";
import { tenantIdFor } from "../knowledge/tenant";
import { TOMBSTONE_KIND } from "./knowledge-constants";

export const KEWY_DOC_MAX = 100_000;
export const GUIDELINES_BLOCK = "guidelines";
export const PUBLISH_RETRY_BATCH = 10;
/** A `pending` older than this is treated as stuck (its process died) and retried. */
export const PUBLISH_STUCK_MS = 5 * 60 * 1000;
/** Failed attempts after which the sweep stops retrying (until the next save). */
export const PUBLISH_MAX_ATTEMPTS = 10;
export const PUBLISH_BACKOFF_BASE_MS = 60 * 1000;
export const PUBLISH_BACKOFF_MAX_MS = 60 * 60 * 1000;
/** Compare-and-set rounds of one publish before it gives up and records a failure. */
export const PUBLISH_CAS_ROUNDS = 3;

/** Wait before the retry following the `attempts`-th failure: 1, 2, 4 … capped at 60 min. */
export function publishBackoffMs(attempts: number): number {
  const n = Math.max(1, Math.floor(attempts));
  return Math.min(PUBLISH_BACKOFF_MAX_MS, PUBLISH_BACKOFF_BASE_MS * 2 ** Math.min(n - 1, 20));
}

export interface Upstream {
  kewy?: { docId: string; truncated?: boolean };
  /** `block`: our guidelines block is in the l prompt; `documentId`: a migrated l document. */
  l?: { block?: string; documentId?: string };
  /** Migrated TONE doc ids (migrate-in). */
  kewyTone?: string[];
  /** The source `version` the last successful publish sent. */
  publishedVersion?: number;
  /** Failed attempts since the last save (cleared by a successful publish). */
  publish?: { attempts: number };
  /** Tombstones: the deleted source's id. */
  tombstoneOf?: string;
}

type Source = {
  id: string;
  workspaceId: string;
  kind: string;
  title: string;
  body: string | null;
  question: string | null;
  status: string;
  upstream: unknown;
  version?: number;
  updatedAt?: Date;
};

type Outcome = "published" | "failed" | "none";

/** Upstream copies still to remove for a deleted source. */
interface Leftovers {
  kewyDocId?: string;
  lDocumentId?: string;
  lBlock?: boolean;
}

const KIND: Record<string, KewyKnowledgeKind> = {
  content: "OTHER",
  faq: "FAQ",
  guideline: "TONE",
  file: "OTHER",
  typed_doc: "OTHER",
  website: "OTHER",
};

class PublishContention extends Error {
  constructor() {
    super("publish contention");
    this.name = "PublishContention";
  }
}

const errName = (e: unknown) => (e as Error)?.name ?? "error";

@Injectable()
export class KnowledgePublisher {
  private readonly log = new Logger(KnowledgePublisher.name);
  private sweeping = false;
  /** Per-source chains: publishes and unpublishes of one source run in order. */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly agentSetup?: LAgentSetupService,
    @Optional() private readonly kewy?: KnowledgeClient,
    @Optional() private readonly lKnowledge?: LKnowledgeService,
  ) {}

  /** Run `job` after every earlier job of this source has settled. */
  private enqueue<T>(sourceId: string, job: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(sourceId) ?? Promise.resolve();
    const run = prev.then(job);
    const tail = run.catch(() => undefined);
    this.chains.set(sourceId, tail);
    void tail.then(() => {
      if (this.chains.get(sourceId) === tail) this.chains.delete(sourceId);
    });
    return run;
  }

  /** After-commit hook: mark pending and publish in the background. Never throws. */
  schedule(sourceId: string): void {
    void this.prisma.knowledgeSource
      .updateMany({ where: { id: sourceId }, data: { publishState: "pending" } })
      .then(() => this.enqueue(sourceId, () => this.publishNow(sourceId, true)))
      .catch(() => this.log.warn(`knowledge source ${sourceId}: publish scheduling failed`));
  }

  /**
   * Who gets copies. Ruling: kewy-ai copies are made only for a workspace
   * with `externalTenantId` (an HJZ salon tenant, i.e. a kewy-ai tenant) AND
   * a configured kewy-ai client; any other workspace gets none. The l prompt
   * block needs `lWorkspaceId` and the agent-setup service.
   */
  private async target(workspaceId: string): Promise<{ l: boolean; kewy: boolean }> {
    const ws = await this.prisma.workspace.findFirst({ where: { id: workspaceId }, select: { lWorkspaceId: true, externalTenantId: true } });
    return {
      l: !!ws?.lWorkspaceId && !!this.agentSetup,
      kewy: !!ws?.externalTenantId && !!this.kewy?.isConfigured(),
    };
  }

  /** Publish one source now (after any earlier job of the source). Records `published` / `failed` / `none`; never throws. */
  publish(sourceId: string): Promise<Outcome> {
    return this.enqueue(sourceId, () => this.publishNow(sourceId, false));
  }

  /** `fresh`: started by a save, so a failure counts from one again. */
  private async publishNow(sourceId: string, fresh: boolean): Promise<Outcome> {
    let src = (await this.prisma.knowledgeSource.findFirst({ where: { id: sourceId } })) as Source | null;
    if (!src || src.kind === TOMBSTONE_KIND) return "none";
    const workspaceId = src.workspaceId;
    // A kewy-ai doc this publish created and has not yet recorded on the row.
    let created: string | undefined;
    try {
      const t = await this.target(workspaceId);
      for (let round = 0; round < PUBLISH_CAS_ROUNDS; round++) {
        const upstream: Upstream = { ...((src.upstream as Upstream | null) ?? {}) };
        delete upstream.publish;
        if (created && !upstream.kewy?.docId) upstream.kewy = { docId: created };
        let did = false;
        if (t.l && src.kind === "guideline") {
          await this.agentSetup!.writePromptBlock(workspaceId, GUIDELINES_BLOCK, src.body ?? "");
          upstream.l = { ...upstream.l, block: GUIDELINES_BLOCK };
          did = true;
        }
        if (t.kewy && src.status === "ready") {
          const doc = await this.kewyDoc(src);
          if (doc) {
            const known = upstream.kewy?.docId;
            const saved = await this.kewy!.upsertDoc({
              tenantId: tenantIdFor(workspaceId),
              id: known,
              title: doc.title,
              body: doc.body,
              kind: KIND[src.kind] ?? "OTHER",
            });
            if (!known) created = saved.id;
            upstream.kewy = { docId: saved.id, ...(doc.truncated ? { truncated: true } : {}) };
            did = true;
          }
        }
        if (typeof src.version === "number") upstream.publishedVersion = src.version;
        const state = did ? "published" : "none";
        // Compare-and-set: only if nothing changed the row since we read it.
        const w = await this.prisma.knowledgeSource.updateMany({
          where: {
            id: src.id,
            ...(typeof src.version === "number" ? { version: src.version } : {}),
            ...(src.updatedAt instanceof Date ? { updatedAt: src.updatedAt } : {}),
          },
          data: { publishState: state, upstream: upstream as unknown as Prisma.InputJsonValue },
        });
        if (w.count === 1) return state;

        // Lost it: the source was deleted, edited or published elsewhere meanwhile.
        const fresh = (await this.prisma.knowledgeSource.findFirst({ where: { id: sourceId } })) as Source | null;
        if (!fresh) {
          // Deleted while in flight: the doc this publish created must not outlive it.
          if (created) await this.deleteKewyQuietly(workspaceId, created);
          return "none";
        }
        const theirs = (fresh.upstream as Upstream | null)?.kewy?.docId;
        if (created && theirs && theirs !== created) {
          // Another publish recorded its doc first: ours is a duplicate.
          await this.deleteKewyQuietly(workspaceId, created);
          created = undefined;
        }
        src = fresh;
      }
      throw new PublishContention();
    } catch (e) {
      // Never provider text: the class name only.
      this.log.warn(`knowledge source ${sourceId}: publish failed (${errName(e)})`);
      await this.recordFailure(sourceId, workspaceId, fresh, created).catch(() => undefined);
      return "failed";
    }
  }

  /** `failed` plus the attempt count (and any doc we created, so it is reused, not orphaned). */
  private async recordFailure(sourceId: string, workspaceId: string, fresh: boolean, created?: string) {
    const row = (await this.prisma.knowledgeSource.findFirst({ where: { id: sourceId } })) as Source | null;
    if (!row) {
      if (created) await this.deleteKewyQuietly(workspaceId, created);
      return;
    }
    const upstream: Upstream = { ...((row.upstream as Upstream | null) ?? {}) };
    if (created) {
      if (!upstream.kewy?.docId) upstream.kewy = { docId: created };
      else if (upstream.kewy.docId !== created) await this.deleteKewyQuietly(workspaceId, created);
    }
    upstream.publish = { attempts: (fresh ? 0 : upstream.publish?.attempts ?? 0) + 1 };
    await this.prisma.knowledgeSource.updateMany({
      where: { id: sourceId },
      data: { publishState: "failed", upstream: upstream as unknown as Prisma.InputJsonValue },
    });
  }

  private async deleteKewyQuietly(workspaceId: string, docId: string) {
    try {
      await this.kewy?.deleteDoc(tenantIdFor(workspaceId), docId);
    } catch (e) {
      this.log.warn(`kewy-ai doc cleanup failed (${errName(e)})`);
      await this.tombstone(workspaceId, null, { kewyDocId: docId }, 1).catch(() => undefined);
    }
  }

  /** The kewy-ai document for a source, or null when it has nothing to say. */
  private async kewyDoc(src: Source): Promise<{ title: string; body: string; truncated: boolean } | null> {
    let body: string;
    let title = src.title;
    if (src.kind === "faq") {
      title = (src.question ?? src.title).slice(0, 300);
      body = src.body ?? "";
    } else if (src.kind === "content" || src.kind === "guideline") {
      body = src.body ?? "";
    } else {
      const chunks = await this.prisma.knowledgeChunk.findMany({
        where: { workspaceId: src.workspaceId, sourceId: src.id },
        orderBy: [{ ord: "asc" }],
        select: { heading: true, text: true },
      });
      body = chunks.map((c) => (c.heading ? `${c.heading}\n${c.text}` : c.text)).join("\n\n");
    }
    if (!body.trim()) return null;
    const truncated = body.length > KEWY_DOC_MAX;
    return { title: title.slice(0, 300), body: truncated ? body.slice(0, KEWY_DOC_MAX) : body, truncated };
  }

  /**
   * Remove a deleted source's upstream copies (best-effort, never throws),
   * after any publish of it still in flight: the kewy-ai document, the
   * guidelines block in the l prompt, and a migrated l document. What fails
   * is kept as a tombstone for the retry sweep.
   */
  async unpublish(src: { id: string; workspaceId: string; kind: string; upstream: unknown }): Promise<void> {
    const upstream = (src.upstream as Upstream | null) ?? {};
    const todo: Leftovers = {
      ...(upstream.kewy?.docId ? { kewyDocId: upstream.kewy.docId } : {}),
      ...(upstream.l?.documentId ? { lDocumentId: upstream.l.documentId } : {}),
      ...(src.kind === "guideline" ? { lBlock: true } : {}),
    };
    await this.enqueue(src.id, async () => {
      const left = await this.removeUpstream(src.workspaceId, todo);
      if (left) await this.tombstone(src.workspaceId, src.id, left, 1);
    }).catch((e) => this.log.warn(`knowledge source ${src.id}: upstream removal failed (${errName(e)})`));
  }

  /** Try each removal; returns what is still left, or null when all is gone. */
  private async removeUpstream(workspaceId: string, todo: Leftovers): Promise<Leftovers | null> {
    const left: Leftovers = {};
    if (todo.kewyDocId && this.kewy?.isConfigured()) {
      try {
        await this.kewy.deleteDoc(tenantIdFor(workspaceId), todo.kewyDocId);
      } catch (e) {
        this.log.warn(`kewy-ai doc removal failed (${errName(e)})`);
        left.kewyDocId = todo.kewyDocId;
      }
    }
    if (todo.lDocumentId && this.lKnowledge) {
      const ws = await this.prisma.workspace.findFirst({ where: { id: workspaceId }, select: { lWorkspaceId: true } });
      if (ws?.lWorkspaceId) {
        try {
          await this.lKnowledge.remove(workspaceId, todo.lDocumentId);
        } catch (e) {
          this.log.warn(`l document removal failed (${errName(e)})`);
          left.lDocumentId = todo.lDocumentId;
        }
      }
    }
    if (todo.lBlock && this.agentSetup) {
      // A guideline saved since owns the block now: leave it.
      const live = await this.prisma.knowledgeSource.findFirst({ where: { workspaceId, kind: "guideline" }, select: { id: true } });
      if (!live) {
        try {
          await this.agentSetup.writePromptBlock(workspaceId, GUIDELINES_BLOCK, "");
        } catch (e) {
          this.log.warn(`guidelines block removal failed (${errName(e)})`);
          left.lBlock = true;
        }
      }
    }
    return Object.keys(left).length ? left : null;
  }

  private async tombstone(workspaceId: string, sourceId: string | null, left: Leftovers, attempts: number) {
    const upstream: Upstream = {
      ...(left.kewyDocId ? { kewy: { docId: left.kewyDocId } } : {}),
      ...(left.lDocumentId || left.lBlock
        ? { l: { ...(left.lDocumentId ? { documentId: left.lDocumentId } : {}), ...(left.lBlock ? { block: GUIDELINES_BLOCK } : {}) } }
        : {}),
      publish: { attempts },
      ...(sourceId ? { tombstoneOf: sourceId } : {}),
    };
    await this.prisma.knowledgeSource.create({
      data: {
        workspaceId,
        kind: TOMBSTONE_KIND,
        status: "deleted",
        title: "Deleted knowledge source",
        publishState: "failed",
        upstream: upstream as unknown as Prisma.InputJsonValue,
      },
    });
  }

  /** One retry of a tombstone: dropped once everything is removed. True when done. */
  private async retryTombstone(id: string): Promise<boolean> {
    const row = await this.prisma.knowledgeSource.findFirst({ where: { id, kind: TOMBSTONE_KIND } });
    if (!row) return true;
    const up = (row.upstream as Upstream | null) ?? {};
    const left = await this.removeUpstream(row.workspaceId, {
      ...(up.kewy?.docId ? { kewyDocId: up.kewy.docId } : {}),
      ...(up.l?.documentId ? { lDocumentId: up.l.documentId } : {}),
      ...(up.l?.block ? { lBlock: true } : {}),
    });
    if (!left) {
      await this.prisma.knowledgeSource.deleteMany({ where: { id, kind: TOMBSTONE_KIND } });
      return true;
    }
    const next: Upstream = {
      ...(left.kewyDocId ? { kewy: { docId: left.kewyDocId } } : {}),
      ...(left.lDocumentId || left.lBlock
        ? { l: { ...(left.lDocumentId ? { documentId: left.lDocumentId } : {}), ...(left.lBlock ? { block: GUIDELINES_BLOCK } : {}) } }
        : {}),
      publish: { attempts: (up.publish?.attempts ?? 0) + 1 },
      ...(up.tombstoneOf ? { tombstoneOf: up.tombstoneOf } : {}),
    };
    await this.prisma.knowledgeSource.updateMany({
      where: { id, kind: TOMBSTONE_KIND },
      data: { publishState: "failed", upstream: next as unknown as Prisma.InputJsonValue },
    });
    return false;
  }

  /**
   * Retry failed publishes and tombstones whose backoff has passed (after the
   * k-th failure: publishBackoffMs(k), measured from the failure's write), and
   * stuck pending ones. Rows with PUBLISH_MAX_ATTEMPTS failures are left alone.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async retry(now = new Date()): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    try {
      const due: Prisma.KnowledgeSourceWhereInput[] = [];
      for (let k = 1; k < PUBLISH_MAX_ATTEMPTS; k++) {
        due.push({
          publishState: "failed",
          upstream: { path: ["publish", "attempts"], equals: k },
          updatedAt: { lt: new Date(now.getTime() - publishBackoffMs(k)) },
        });
      }
      due.push({ publishState: "pending", updatedAt: { lt: new Date(now.getTime() - PUBLISH_STUCK_MS) } });
      const rows = await this.prisma.knowledgeSource.findMany({
        where: { OR: due },
        select: { id: true, kind: true },
        orderBy: { updatedAt: "asc" },
        take: PUBLISH_RETRY_BATCH,
      });
      let ok = 0;
      for (const r of rows) {
        if (r.kind === TOMBSTONE_KIND) {
          if (await this.enqueue(r.id, () => this.retryTombstone(r.id)).catch(() => false)) ok += 1;
        } else if ((await this.publish(r.id)) !== "failed") ok += 1;
      }
      return ok;
    } finally {
      this.sweeping = false;
    }
  }
}
