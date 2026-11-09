/**
 * Realtime vs filters: a board with filters applied can't tell whether an
 * incoming ticket matches them, so only caches without a filter are patched
 * locally; filtered stage caches and the table are refetched instead.
 */
type Key = readonly unknown[];

function isStageKeyOf(key: Key, pipelineId: string): boolean {
  return key[0] === "tickets" && key[1] === "stage" && key[2] === pipelineId;
}

function hasFilters(key: Key): boolean {
  const f = key[4];
  return !!f && typeof f === "object" && typeof (f as { qs?: unknown }).qs === "string" && (f as { qs: string }).qs !== "";
}

/** A stage cache of this pipeline whose filters.qs is empty: safe to patch in place. */
export function isUnfilteredStageKey(key: Key, pipelineId: string): boolean {
  return isStageKeyOf(key, pipelineId) && !hasFilters(key);
}

/** Caches to debounce-invalidate: filtered stage caches of this pipeline and its table queries. */
export function isRefetchOnRealtimeKey(key: Key, pipelineId: string): boolean {
  if (key[0] === "tickets" && key[1] === "table" && key[2] === pipelineId) return true;
  return isStageKeyOf(key, pipelineId) && hasFilters(key);
}
