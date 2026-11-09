import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreatePipelineDto } from "./pipelines.dto";
import { slugify, validateDraft, type CurrentPipeline, type DraftInput } from "./stage-draft";

/** The lost reasons every new pipeline starts with (same set the old modal hardcoded). */
export const DEFAULT_LOST_REASONS = [
  { label: "Price too high", labelAr: "السعر مرتفع" },
  { label: "Found cheaper alternative", labelAr: "وجد بديلاً أرخص" },
  { label: "Customer went silent", labelAr: "توقف العميل" },
  { label: "Wrong product fit", labelAr: "غير مناسب" },
  { label: "Other", labelAr: "أخرى" },
];

@Injectable()
export class PipelinesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(workspaceId: string, includeArchived: boolean) {
    return this.prisma.pipeline.findMany({
      where: { workspaceId, ...(includeArchived ? {} : { archivedAt: null }) },
      orderBy: { createdAt: "asc" },
      include: {
        stages: { orderBy: { order: "asc" } },
        _count: { select: { tickets: true } },
      },
    });
  }

  private async load(workspaceId: string, id: string, db: any = this.prisma) {
    const p = await db.pipeline.findFirst({
      where: { id, workspaceId },
      include: {
        stages: { orderBy: { order: "asc" }, include: { _count: { select: { tickets: true } } } },
        lostReasons: { orderBy: { order: "asc" }, include: { _count: { select: { tickets: true } } } },
      },
    });
    if (!p) throw new NotFoundException("Pipeline not found");
    return p;
  }

  /** Pipeline + stages (with ticketCount) + active lost reasons. Also the 409 `current`. */
  async get(workspaceId: string, id: string) {
    const p = await this.load(workspaceId, id);
    const { stages, lostReasons, ...rest } = p;
    return {
      ...rest,
      stages: stages.map(({ _count, ...s }: any) => ({ ...s, ticketCount: _count?.tickets ?? 0 })),
      lostReasons: lostReasons
        .filter((r: any) => r.archivedAt == null)
        .map(({ _count, ...r }: any) => r),
    };
  }

  async lostReasons(workspaceId: string, id: string) {
    const p = await this.prisma.pipeline.findFirst({ where: { id, workspaceId }, select: { id: true } });
    if (!p) throw new NotFoundException("Pipeline not found");
    return this.prisma.lostReason.findMany({
      where: { pipelineId: id, workspaceId, archivedAt: null },
      orderBy: { order: "asc" },
    });
  }

  async create(workspaceId: string, dto: CreatePipelineDto) {
    const existing = await this.prisma.pipeline.findMany({ where: { workspaceId }, select: { key: true } });
    const used = new Set(existing.map((p: { key: string }) => p.key));
    const base = slugify(dto.name);
    let key = base;
    for (let n = 2; used.has(key); n++) key = `${base}_${n}`;

    // groupKey "custom_*" keeps PipelineAutomationService (which adopts the
    // first pipeline with "new"/"contacted" groups) away from user-made pipelines.
    const stage = (k: string, label: string, labelAr: string, color: string, order: number, isTerminal: boolean, isWon: boolean) => ({
      key: k, label, labelAr, color, order, groupKey: `custom_${k}`, isTerminal, isWon, workspaceId,
    });
    return this.prisma.pipeline.create({
      data: {
        workspaceId,
        key,
        name: dto.name.trim(),
        nameAr: dto.nameAr.trim(),
        kind: dto.kind ?? "deals",
        isDefault: false,
        stages: {
          create: [
            stage("new", "New", "جديد", "info", 0, false, false),
            stage("in_progress", "In progress", "قيد التنفيذ", "warn", 1, false, false),
            stage("won", "Won", "تم الكسب", "ok", 2, true, true),
            stage("lost", "Lost", "خسارة", "bad", 3, true, false),
          ],
        },
        lostReasons: {
          create: DEFAULT_LOST_REASONS.map((r, order) => ({ ...r, order, workspaceId })),
        },
      },
      include: { stages: { orderBy: { order: "asc" } } },
    });
  }

  private conflict(current: unknown): ConflictException {
    return new ConflictException({ statusCode: 409, message: "pipelines.version_conflict", current });
  }

  async saveDraft(workspaceId: string, id: string, draft: DraftInput) {
    const p = await this.load(workspaceId, id);
    if (draft.version !== p.version) throw this.conflict(await this.get(workspaceId, id));

    const current: CurrentPipeline = {
      version: p.version,
      stages: p.stages.map((s: any) => ({
        id: s.id, key: s.key, label: s.label, labelAr: s.labelAr, color: s.color, order: s.order,
        isTerminal: s.isTerminal, isWon: s.isWon, slaMinutes: s.slaMinutes ?? null,
        ticketCount: s._count?.tickets ?? 0,
      })),
      lostReasons: p.lostReasons.map((r: any) => ({
        id: r.id, inUse: (r._count?.tickets ?? 0) > 0, archived: r.archivedAt != null,
      })),
    };
    const result = validateDraft(current, draft);
    if (!result.ok) throw new BadRequestException(result.key);
    const plan = result.plan;
    const keyById = new Map<string, string>(p.stages.map((s: any) => [s.id, s.key]));

    await this.prisma.$transaction(async (tx: any) => {
      // Guarded write first: it takes the row lock, so a concurrent save waits,
      // then matches 0 rows (version moved) and is rejected as a conflict.
      const guard = await tx.pipeline.updateMany({
        where: { id, workspaceId, version: draft.version },
        data: { ...plan.pipeline, version: { increment: 1 } },
      });
      if (guard.count === 0) throw this.conflict(undefined);

      for (const u of plan.stageUpdates) {
        await tx.ticketStage.update({ where: { id: u.id }, data: u.data });
      }
      for (const c of plan.stageCreates) {
        await tx.ticketStage.create({
          data: { ...c, groupKey: `custom_${c.key}`, pipelineId: id, workspaceId },
        });
      }

      const finalById = new Map(plan.stageUpdates.map((u) => [u.id, u.data]));
      for (const d of plan.stageDeletes) {
        const tickets: Array<{ id: string }> = await tx.ticket.findMany({
          where: { stageId: d.stageId, workspaceId },
          select: { id: true },
        });
        if (tickets.length > 0) {
          if (!d.moveTo) throw new BadRequestException("pipelines.move_target_required");
          const target = finalById.get(d.moveTo)!;
          const now = new Date();
          const toLost = target.isTerminal && !target.isWon;
          await tx.ticket.updateMany({
            where: { stageId: d.stageId, workspaceId },
            data: {
              stageId: d.moveTo,
              enteredStageAt: now,
              closedAt: target.isTerminal ? now : null,
              ...(toLost ? {} : { lostReason: null, lostReasonId: null }),
            },
          });
          await tx.ticketActivity.createMany({
            data: tickets.map((t) => ({
              workspaceId,
              ticketId: t.id,
              kind: "stage_changed",
              note: "stage removed",
              fromStage: keyById.get(d.stageId) ?? null,
              toStage: keyById.get(d.moveTo!) ?? null,
            })),
          });
        }
        await tx.ticketStage.delete({ where: { id: d.stageId } });
      }

      if (plan.lostReasonCreates.length > 0) {
        await tx.lostReason.createMany({
          data: plan.lostReasonCreates.map((r) => ({ ...r, pipelineId: id, workspaceId })),
        });
      }
      for (const r of plan.lostReasonUpdates) {
        await tx.lostReason.update({
          where: { id: r.id },
          data: { label: r.label, labelAr: r.labelAr, order: r.order, ...(r.archived ? {} : { archivedAt: null }) },
        });
      }
      if (plan.lostReasonArchives.length > 0) {
        await tx.lostReason.updateMany({
          where: { id: { in: plan.lostReasonArchives }, pipelineId: id, workspaceId },
          data: { archivedAt: new Date() },
        });
      }
      if (plan.lostReasonDeletes.length > 0) {
        await tx.lostReason.deleteMany({
          where: { id: { in: plan.lostReasonDeletes }, pipelineId: id, workspaceId },
        });
      }
    }).catch(async (e: unknown) => {
      if (e instanceof ConflictException && (e.getResponse() as any)?.current === undefined) {
        throw this.conflict(await this.get(workspaceId, id));
      }
      throw e;
    });

    return this.get(workspaceId, id);
  }

  async archive(workspaceId: string, id: string) {
    const p = await this.load(workspaceId, id);
    if (p.isDefault) throw new BadRequestException("pipelines.cannot_archive_default");
    await this.prisma.pipeline.updateMany({
      where: { id, workspaceId },
      data: { archivedAt: p.archivedAt ?? new Date(), version: { increment: 1 } },
    });
    return this.get(workspaceId, id);
  }

  async unarchive(workspaceId: string, id: string) {
    await this.load(workspaceId, id);
    await this.prisma.pipeline.updateMany({
      where: { id, workspaceId },
      data: { archivedAt: null, version: { increment: 1 } },
    });
    return this.get(workspaceId, id);
  }
}
