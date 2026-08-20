/**
 * Everything a brand-new workspace needs to be usable on day one.
 *
 * Before this existed, provisioning created only user + workspace + membership:
 * the client's Pipeline screen was empty, the inbound-message automation
 * silently no-opped (it resolves stages by groupKey and there were none), and
 * the Contacts → Groups tab had nothing in it. Stage groups had been backfilled
 * by a one-off migration and the starter segments by a manual script, neither
 * of which can run for a workspace created later.
 *
 * Idempotent by design so it can also repair an existing workspace: every step
 * checks for what it would create first.
 */

/** The default sales pipeline's stages. `groupKey` is what the inbound-message
 *  automation looks up ("new" on arrival, "contacted" once we reply), so those
 *  two keys must exist for it to work. */
export const DEFAULT_STAGES = [
  { key: "new",        label: "New",        labelAr: "جديد",       color: "info",   order: 0, groupKey: "new",        slaMinutes: 60 * 4,  isTerminal: false, isWon: false },
  { key: "contacted",  label: "Contacted",  labelAr: "تم التواصل", color: "info",   order: 1, groupKey: "contacted",  slaMinutes: 60 * 24, isTerminal: false, isWon: false },
  { key: "interested", label: "Interested", labelAr: "مهتم",       color: "accent", order: 2, groupKey: "interested", slaMinutes: 60 * 48, isTerminal: false, isWon: false },
  { key: "waiting",    label: "Waiting",    labelAr: "بالانتظار",  color: "warn",   order: 3, groupKey: "waiting",    slaMinutes: 60 * 72, isTerminal: false, isWon: false },
  { key: "won",        label: "Won",        labelAr: "تم الفوز",   color: "ok",     order: 4, groupKey: "won",        slaMinutes: null,    isTerminal: true,  isWon: true  },
  { key: "lost",       label: "Lost",       labelAr: "خسارة",      color: "bad",    order: 5, groupKey: "lost",       slaMinutes: null,    isTerminal: true,  isWon: false },
] as const;

/** Property-based smart groups — evaluated live from contact fields. */
export const STARTER_SEGMENTS = [
  { name: "All leads", nameAr: "العملاء المحتملون", color: "30",  filter: { lifecycle: ["lead"] } },
  { name: "Customers", nameAr: "العملاء",           color: "150", filter: { lifecycle: ["customer"] } },
  { name: "Has phone", nameAr: "لديهم هاتف",        color: "240", filter: { hasPhone: true } },
  { name: "No phone",  nameAr: "بدون هاتف",         color: "320", filter: { hasPhone: false } },
] as const;

/** Stage colour token → the hue string segments use for their accent. */
const HUE_BY_STAGE_COLOR: Record<string, string> = {
  ok: "150",
  bad: "0",
  warn: "30",
  accent: "270",
  info: "210",
};

/** One smart group per pipeline stage: "contacts with a deal sitting here". */
export function stageSegmentsFor(
  stages: ReadonlyArray<{ key: string; label: string; labelAr: string; color: string; isTerminal: boolean }>,
) {
  return stages.map((s) => ({
    name: s.isTerminal ? `${s.label} deals` : s.label,
    nameAr: s.isTerminal ? `صفقات ${s.labelAr}` : s.labelAr,
    color: HUE_BY_STAGE_COLOR[s.color] ?? "210",
    filter: { stageAny: [s.key] },
  }));
}

/** The subset of Prisma we need — satisfied by both the client and a `$transaction` handle. */
interface DefaultsClient {
  pipeline: {
    findFirst(args: unknown): Promise<{ id: string } | null>;
    create(args: unknown): Promise<{ id: string }>;
  };
  ticketStage: {
    findMany(args: unknown): Promise<Array<{ key: string }>>;
    create(args: unknown): Promise<unknown>;
  };
  segment: {
    findMany(args: unknown): Promise<Array<{ name: string }>>;
    create(args: unknown): Promise<unknown>;
  };
}

export interface WorkspaceDefaultsResult {
  pipelineId: string;
  stagesCreated: number;
  segmentsCreated: number;
}

/**
 * Create the default pipeline, its stages, and the starter + per-stage smart
 * groups for `workspaceId`. Safe to re-run: existing rows are left alone.
 *
 * Pass a transaction handle when the caller is already inside one, so a failed
 * provisioning rolls the defaults back with it.
 */
export async function seedWorkspaceDefaults(
  db: DefaultsClient,
  workspaceId: string,
): Promise<WorkspaceDefaultsResult> {
  let pipeline = await db.pipeline.findFirst({
    where: { workspaceId, key: "sales" },
    select: { id: true },
  });
  if (!pipeline) {
    pipeline = await db.pipeline.create({
      data: {
        workspaceId,
        key: "sales",
        name: "Sales",
        nameAr: "المبيعات",
        isDefault: true,
      },
      select: { id: true },
    });
  }

  const haveStages = new Set(
    (await db.ticketStage.findMany({ where: { workspaceId }, select: { key: true } })).map(
      (s) => s.key,
    ),
  );
  let stagesCreated = 0;
  for (const s of DEFAULT_STAGES) {
    if (haveStages.has(s.key)) continue;
    await db.ticketStage.create({
      data: {
        workspaceId,
        pipelineId: pipeline.id,
        key: s.key,
        label: s.label,
        labelAr: s.labelAr,
        color: s.color,
        order: s.order,
        groupKey: s.groupKey,
        slaMinutes: s.slaMinutes,
        isTerminal: s.isTerminal,
        isWon: s.isWon,
      },
    });
    stagesCreated += 1;
  }

  const haveSegments = new Set(
    (await db.segment.findMany({ where: { workspaceId }, select: { name: true } })).map(
      (s) => s.name,
    ),
  );
  let segmentsCreated = 0;
  for (const seg of [...STARTER_SEGMENTS, ...stageSegmentsFor(DEFAULT_STAGES)]) {
    if (haveSegments.has(seg.name)) continue;
    await db.segment.create({
      data: {
        workspaceId,
        name: seg.name,
        nameAr: seg.nameAr,
        color: seg.color,
        origin: "crm",
        filter: JSON.stringify(seg.filter),
      },
    });
    haveSegments.add(seg.name);
    segmentsCreated += 1;
  }

  return { pipelineId: pipeline.id, stagesCreated, segmentsCreated };
}
