/**
 * SP-21 publishing (ruling 2, ruling 11). After-commit, never fails a save.
 *
 *  - l agent (workspace has `lWorkspaceId`): nothing is copied; the agent
 *    reads through `search_knowledge`. Only the guidelines go into its live
 *    prompt, as the bounded block `kewy-crm-guidelines` (one PUT per change;
 *    an empty guideline removes the block).
 *  - kewy-ai (the client is configured and the workspace is an HJZ salon
 *    tenant, i.e. it has `externalTenantId`): content (`OTHER`), each FAQ
 *    (`FAQ`, title = question), the guidelines (`TONE`), and every file,
 *    typed document and website as one `OTHER` document of its chunk text
 *    (≤ KEWY_DOC_MAX chars; longer → truncated and recorded). The upstream id
 *    is kept in `upstream.kewy.docId` and reused, so an edit updates the same
 *    document; delete removes it (best-effort).
 *
 * `schedule(id)` marks the source `publishState: "pending"` and publishes in
 * the background; a failure leaves `failed` (only the error class is logged)
 * and the retry sweep picks it up.
 */
import { Injectable, Logger, Optional } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { LAgentSetupService } from "../integrations/l-agent-setup.service";
import { KnowledgeClient, type KewyKnowledgeKind } from "../knowledge/knowledge.client";
import { tenantIdFor } from "../knowledge/tenant";

export const KEWY_DOC_MAX = 100_000;
export const GUIDELINES_BLOCK = "guidelines";
export const PUBLISH_RETRY_BATCH = 10;
/** A `pending` older than this is treated as stuck (its process died) and retried. */
export const PUBLISH_STUCK_MS = 5 * 60 * 1000;

export interface Upstream {
  kewy?: { docId: string; truncated?: boolean };
  l?: { block?: string };
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
};

const KIND: Record<string, KewyKnowledgeKind> = {
  content: "OTHER",
  faq: "FAQ",
  guideline: "TONE",
  file: "OTHER",
  typed_doc: "OTHER",
  website: "OTHER",
};

@Injectable()
export class KnowledgePublisher {
  private readonly log = new Logger(KnowledgePublisher.name);
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly agentSetup?: LAgentSetupService,
    @Optional() private readonly kewy?: KnowledgeClient,
  ) {}

  /** After-commit hook: mark pending and publish in the background. Never throws. */
  schedule(sourceId: string): void {
    void this.prisma.knowledgeSource
      .updateMany({ where: { id: sourceId }, data: { publishState: "pending" } })
      .then(() => this.publish(sourceId))
      .catch(() => this.log.warn(`knowledge source ${sourceId}: publish scheduling failed`));
  }

  private async target(workspaceId: string): Promise<{ l: boolean; kewy: boolean }> {
    const ws = await this.prisma.workspace.findFirst({ where: { id: workspaceId }, select: { lWorkspaceId: true, externalTenantId: true } });
    return {
      l: !!ws?.lWorkspaceId && !!this.agentSetup,
      kewy: !!ws?.externalTenantId && !!this.kewy?.isConfigured(),
    };
  }

  /** Publish one source now. Records `published` / `failed` / `none`; never throws. */
  async publish(sourceId: string): Promise<"published" | "failed" | "none"> {
    const src = (await this.prisma.knowledgeSource.findFirst({ where: { id: sourceId } })) as Source | null;
    if (!src) return "none";
    try {
      const t = await this.target(src.workspaceId);
      const upstream: Upstream = { ...((src.upstream as Upstream | null) ?? {}) };
      let did = false;
      if (t.l && src.kind === "guideline") {
        await this.agentSetup!.writePromptBlock(src.workspaceId, GUIDELINES_BLOCK, src.body ?? "");
        upstream.l = { block: GUIDELINES_BLOCK };
        did = true;
      }
      if (t.kewy && src.status === "ready") {
        const doc = await this.kewyDoc(src);
        if (doc) {
          const saved = await this.kewy!.upsertDoc({
            tenantId: tenantIdFor(src.workspaceId),
            id: upstream.kewy?.docId,
            title: doc.title,
            body: doc.body,
            kind: KIND[src.kind] ?? "OTHER",
          });
          upstream.kewy = { docId: saved.id, ...(doc.truncated ? { truncated: true } : {}) };
          did = true;
        }
      }
      const state = did ? "published" : "none";
      await this.prisma.knowledgeSource.updateMany({
        where: { id: src.id },
        data: { publishState: state, upstream: upstream as unknown as Prisma.InputJsonValue },
      });
      return state;
    } catch (e) {
      // Never provider text: the class name only.
      this.log.warn(`knowledge source ${src.id}: publish failed (${(e as Error)?.name ?? "error"})`);
      await this.prisma.knowledgeSource.updateMany({ where: { id: src.id }, data: { publishState: "failed" } }).catch(() => undefined);
      return "failed";
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
   * Remove a deleted source's upstream copies (best-effort, never throws):
   * the kewy-ai document, and the guidelines block from the l prompt.
   */
  async unpublish(src: { id: string; workspaceId: string; kind: string; upstream: unknown }): Promise<void> {
    const upstream = (src.upstream as Upstream | null) ?? {};
    try {
      if (upstream.kewy?.docId && this.kewy?.isConfigured()) {
        await this.kewy.deleteDoc(tenantIdFor(src.workspaceId), upstream.kewy.docId);
      }
      if (src.kind === "guideline" && this.agentSetup) {
        await this.agentSetup.writePromptBlock(src.workspaceId, GUIDELINES_BLOCK, "");
      }
    } catch (e) {
      this.log.warn(`knowledge source ${src.id}: upstream removal failed (${(e as Error)?.name ?? "error"})`);
    }
  }

  /** Retry failed (and stuck pending) publishes. */
  @Cron(CronExpression.EVERY_MINUTE)
  async retry(now = new Date()): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    try {
      const rows = await this.prisma.knowledgeSource.findMany({
        where: {
          OR: [{ publishState: "failed" }, { publishState: "pending", updatedAt: { lt: new Date(now.getTime() - PUBLISH_STUCK_MS) } }],
        },
        select: { id: true },
        orderBy: { updatedAt: "asc" },
        take: PUBLISH_RETRY_BATCH,
      });
      let ok = 0;
      for (const r of rows) if ((await this.publish(r.id)) !== "failed") ok += 1;
      return ok;
    } finally {
      this.sweeping = false;
    }
  }
}
