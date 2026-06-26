import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class MarketingOutboundService {
  private readonly logger = new Logger(MarketingOutboundService.name);

  constructor(private readonly prisma: PrismaService) {}

  isConfigured(): boolean {
    return !!(process.env.HJZ_OUTBOUND_URL && process.env.HJZ_WEBHOOK_SECRET);
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
    if (seg.origin !== "crm") {
      this.logger.debug(`segment ${segmentId} origin=${seg.origin} — only crm-origin gets emitted`);
      return false;
    }
    let filter: any = {};
    try {
      const parsed = JSON.parse(seg.filter || "{}");
      if (parsed && typeof parsed === "object") filter = parsed;
    } catch {
      /* malformed filter — treat as empty, no rows match */
    }
    const contacts = await this.prisma.contact.findMany({
      where: {
        workspaceId,
        externalSource: "hjz",
        externalId: { not: null },
        ...this.where(filter),
      },
      select: { externalId: true },
    });
    const hjzClientIds = contacts.map((c: { externalId: string | null }) => c.externalId).filter((x: string | null): x is string => !!x);
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
    const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (!ws?.externalTenantId) return false;
    return this.post({
      event: "segment.deleted",
      segment: { id: segmentId, tenantId: ws.externalTenantId },
    });
  }

  async resyncAllToHjz(workspaceId: string): Promise<{
    total: number; sent: number; failed: number; configured: boolean;
  }> {
    if (!this.isConfigured()) return { total: 0, sent: 0, failed: 0, configured: false };
    const segs = await this.prisma.segment.findMany({
      where: { workspaceId, origin: 'crm' },
      select: { id: true },
    });
    let sent = 0; let failed = 0;
    for (const s of segs) {
      const ok = await this.emitSegmentUpserted(workspaceId, s.id);
      if (ok) sent++; else failed++;
    }
    return { total: segs.length, sent, failed, configured: true };
  }

  private async post(payload: unknown): Promise<boolean> {
    const url = process.env.HJZ_OUTBOUND_URL!;
    const secret = process.env.HJZ_WEBHOOK_SECRET!;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-marketing-secret": secret },
        body: JSON.stringify(payload),
      });
      if (!res.ok) this.logger.warn(`hjz outbound failed -> HTTP ${res.status}`);
      return res.ok;
    } catch (e: unknown) {
      this.logger.warn(`hjz outbound failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  private where(f: Record<string, unknown>) {
    const w: Record<string, unknown> = {};
    if (Array.isArray(f?.lifecycle) && f.lifecycle.length) w.lifecycle = { in: f.lifecycle };
    if (Array.isArray(f?.industry) && f.industry.length)   w.industry  = { in: f.industry };
    if (Array.isArray(f?.source) && f.source.length)       w.source    = { in: f.source };
    if (typeof f?.search === "string" && f.search.trim())  w.name      = { contains: f.search.trim(), mode: "insensitive" };
    if (f?.hasPhone === true)  w.phone = { not: null };
    if (f?.hasPhone === false) w.phone = null;
    return w;
  }

  private summarizeFilter(f: Record<string, unknown>): string | null {
    const parts: string[] = [];
    if (Array.isArray(f?.lifecycle) && f.lifecycle.length) parts.push(`lifecycle in [${(f.lifecycle as string[]).join(", ")}]`);
    if (Array.isArray(f?.source) && f.source.length)       parts.push(`source in [${(f.source as string[]).join(", ")}]`);
    if (Array.isArray(f?.tagsAll) && f.tagsAll.length)     parts.push(`tagsAll: ${(f.tagsAll as string[]).join(", ")}`);
    if (Array.isArray(f?.tagsAny) && f.tagsAny.length)     parts.push(`tagsAny: ${(f.tagsAny as string[]).join(", ")}`);
    return parts.length ? parts.join("; ") : null;
  }
}
