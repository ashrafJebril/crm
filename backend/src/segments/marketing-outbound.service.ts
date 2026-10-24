import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { hjzWebhookUrl, postToHjz } from "../hjz-sync/hjz-api";
import { SegmentsService } from "./segments.service";

/** Segments the CRM owns and pushes to HJZ; "hjz" ones are HJZ's own mirrors. */
const PUSHED_ORIGINS = new Set(["crm", "manual"]);

@Injectable()
export class MarketingOutboundService {
  private readonly logger = new Logger(MarketingOutboundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly segments: SegmentsService,
  ) {}

  isConfigured(): boolean {
    return hjzWebhookUrl("segments") !== null;
  }

  async emitSegmentUpserted(workspaceId: string, segmentId: string): Promise<boolean> {
    if (!this.isConfigured()) return false;
    const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (!ws?.externalTenantId) {
      this.logger.debug(`workspace ${workspaceId} has no externalTenantId — skipping HJZ emit`);
      return false;
    }
    const seg = await this.prisma.segment.findFirst({ where: { id: segmentId, workspaceId } });
    if (!seg) return false;
    if (!PUSHED_ORIGINS.has(seg.origin)) {
      this.logger.debug(`segment ${segmentId} origin=${seg.origin} — hjz mirrors are never echoed back`);
      return false;
    }
    const filter = seg.origin === "crm" ? this.segments.parseFilter(seg.filter) : {};
    // Same audience resolution as the contacts list (filter for crm, members
    // for manual), restricted to contacts linked to an hjz client.
    const audience = await this.segments.resolveContactWhere(workspaceId, seg.id);
    const contacts = await this.prisma.contact.findMany({
      where: { AND: [audience, { hjzClientId: { not: null } }] },
      select: { hjzClientId: true },
    });
    const hjzClientIds = contacts.map((c) => c.hjzClientId).filter((x): x is string => !!x);
    const payload = {
      event: "segment.upserted",
      segment: {
        id: seg.id,
        tenantId: ws.externalTenantId,
        name: seg.name,
        ruleSummary: this.summarizeFilter(filter),
        hjzClientIds,
      },
    };
    return this.post(payload);
  }

  async emitSegmentDeleted(workspaceId: string, segmentId: string): Promise<boolean> {
    if (!this.isConfigured()) return false;
    // Pre-existing CRM-only contract: never emit a delete for an hjz-origin
    // segment. The controller already enforces this; this guard mirrors the
    // upsert path so any future caller (scheduler, admin route) gets the
    // same protection.
    const seg = await this.prisma.segment.findFirst({ where: { id: segmentId, workspaceId } });
    if (seg && !PUSHED_ORIGINS.has(seg.origin)) {
      this.logger.debug(`segment ${segmentId} origin=${seg.origin} — hjz mirror deletes are never emitted`);
      return false;
    }
    // Note: if seg is null (already hard-deleted by the time we get here),
    // we still emit the delete event — that's intentional because the
    // typical call site is SegmentsController.remove, which deletes first
    // then calls us; HJZ will idempotently no-op a delete for an unknown id.
    const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (!ws?.externalTenantId) return false;
    return this.post({
      event: "segment.deleted",
      segment: { id: segmentId, tenantId: ws.externalTenantId },
    });
  }

  async resyncAllToHjz(workspaceId: string): Promise<{
    total: number; sent: number; failed: number; skipped: number; configured: boolean;
  }> {
    if (!this.isConfigured()) return { total: 0, sent: 0, failed: 0, skipped: 0, configured: false };
    const segs = await this.prisma.segment.findMany({
      where: { workspaceId, origin: { in: [...PUSHED_ORIGINS] } },
      select: { id: true },
    });
    let sent = 0; let failed = 0; let skipped = 0;
    for (const s of segs) {
      try {
        const ok = await this.emitSegmentUpserted(workspaceId, s.id);
        if (ok) sent++; else skipped++;  // false here = guard skip (no externalTenantId, non-crm origin, etc.) — not a delivery failure
      } catch (e: any) {
        this.logger.warn(`resync segment ${s.id} threw: ${e?.message ?? e}`);
        failed++;
      }
    }
    return { total: segs.length, sent, failed, skipped, configured: true };
  }

  private async post(payload: unknown): Promise<boolean> {
    try {
      const res = await postToHjz("segments", payload);
      if (!res.ok) this.logger.warn(`hjz outbound failed -> HTTP ${res.status}`);
      return res.ok;
    } catch (e: unknown) {
      this.logger.warn(`hjz outbound failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  private summarizeFilter(f: Record<string, any>): string | null {
    const parts: string[] = [];
    if (Array.isArray(f?.lifecycle) && f.lifecycle.length) parts.push(`lifecycle in [${(f.lifecycle as string[]).join(", ")}]`);
    if (Array.isArray(f?.source) && f.source.length)       parts.push(`source in [${(f.source as string[]).join(", ")}]`);
    if (Array.isArray(f?.tagsAll) && f.tagsAll.length)     parts.push(`tagsAll: ${(f.tagsAll as string[]).join(", ")}`);
    if (Array.isArray(f?.tagsAny) && f.tagsAny.length)     parts.push(`tagsAny: ${(f.tagsAny as string[]).join(", ")}`);
    return parts.length ? parts.join("; ") : null;
  }
}
