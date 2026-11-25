/**
 * SP-18 seal of a pending action: the canonical sha256 of {tool, args, card}
 * (the ads gate's canonicalisation, imported, not copied). Computed at
 * proposal, recomputed at approval: a stored row whose tool, args or card no
 * longer hash to the seal was changed after the member saw the card, and is
 * refused. A consistency seal, not a cryptographic one (see ads-args-hash).
 */
import { hashAction } from "../ads/ads-args-hash";
import type { ActionCard } from "./copilot-tools/registry";

export function sealAction(tool: string, args: unknown, card: ActionCard): string {
  // The card goes inside the canonicalised value (jsonb may reorder its keys).
  return hashAction(tool, { args, card }, "copilot");
}

export function sealMatches(row: { tool: string; argsJson: unknown; card: unknown; argsHash: string }): boolean {
  return sealAction(row.tool, row.argsJson, row.card as ActionCard) === row.argsHash;
}
