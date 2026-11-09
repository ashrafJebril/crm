/** The lost reasons every new pipeline starts with (same set the old modal hardcoded). */
export const DEFAULT_LOST_REASONS = [
  { label: "Price too high", labelAr: "السعر مرتفع" },
  { label: "Found cheaper alternative", labelAr: "وجد بديلاً أرخص" },
  { label: "Customer went silent", labelAr: "توقف العميل" },
  { label: "Wrong product fit", labelAr: "غير مناسب" },
  { label: "Other", labelAr: "أخرى" },
];

interface LostReasonTx {
  lostReason: {
    count(args: unknown): Promise<number>;
    createMany(args: unknown): Promise<unknown>;
  };
  $executeRaw?: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
}
interface LostReasonDb extends LostReasonTx {
  $transaction?: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
}

/**
 * Idempotent and race-safe: seeds DEFAULT_LOST_REASONS only when the pipeline
 * has no LostReason rows at all (archived ones count, so a deliberately emptied
 * list is never re-filled). count + createMany run under a per-pipeline
 * advisory transaction lock so two concurrent first calls cannot both seed.
 * A handle that is already a transaction (no `$transaction`) is used as is.
 * Returns whether it created anything.
 */
export async function ensureDefaultLostReasons(
  db: LostReasonDb,
  workspaceId: string,
  pipelineId: string,
): Promise<boolean> {
  const run = async (tx: LostReasonTx): Promise<boolean> => {
    if (tx.$executeRaw) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('lost-reasons:' || ${pipelineId}))`;
    }
    const n = await tx.lostReason.count({ where: { workspaceId, pipelineId } });
    if (n > 0) return false;
    await tx.lostReason.createMany({
      data: DEFAULT_LOST_REASONS.map((r, order) => ({ ...r, order, workspaceId, pipelineId })),
    });
    return true;
  };
  return typeof db.$transaction === "function" ? db.$transaction((tx) => run(tx)) : run(db);
}
