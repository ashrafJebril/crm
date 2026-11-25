/** Max length of a stored reaction (an emoji, possibly a ZWJ sequence). */
export const MAX_REACTION_LENGTH = 16;

/**
 * Normalize a provider reaction emoji for storage on Message.reaction.
 * - "" / whitespace / null (a removed reaction) -> null (clear the column)
 * - a plausible emoji string -> that string
 * - anything longer than MAX_REACTION_LENGTH -> undefined (ignore the event)
 */
export function normalizeReaction(raw: unknown): string | null | undefined {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") return undefined;
  const v = raw.trim();
  if (v === "") return null;
  return [...v].length <= MAX_REACTION_LENGTH && v.length <= MAX_REACTION_LENGTH ? v : undefined;
}
