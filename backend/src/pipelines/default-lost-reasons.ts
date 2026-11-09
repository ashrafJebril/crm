/** The lost reasons every new pipeline starts with (same set the old modal hardcoded). */
export const DEFAULT_LOST_REASONS = [
  { label: "Price too high", labelAr: "السعر مرتفع" },
  { label: "Found cheaper alternative", labelAr: "وجد بديلاً أرخص" },
  { label: "Customer went silent", labelAr: "توقف العميل" },
  { label: "Wrong product fit", labelAr: "غير مناسب" },
  { label: "Other", labelAr: "أخرى" },
];

interface LostReasonDb {
  lostReason: {
    count(args: unknown): Promise<number>;
    createMany(args: unknown): Promise<unknown>;
  };
}

/**
 * Idempotent: seeds DEFAULT_LOST_REASONS only when the pipeline has no
 * LostReason rows at all (archived ones count, so a deliberately emptied list
 * is never re-filled). Returns whether it created anything.
 */
export async function ensureDefaultLostReasons(
  db: LostReasonDb,
  workspaceId: string,
  pipelineId: string,
): Promise<boolean> {
  const n = await db.lostReason.count({ where: { workspaceId, pipelineId } });
  if (n > 0) return false;
  await db.lostReason.createMany({
    data: DEFAULT_LOST_REASONS.map((r, order) => ({ ...r, order, workspaceId, pipelineId })),
  });
  return true;
}
