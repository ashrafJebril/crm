import { createHash } from "node:crypto";
import { isNativeSlot, slotKeys, type VarMap, type VarSlot } from "./var-map";

/**
 * SP-13 transport choice (ruling 1). Recipients are grouped by
 * `(sender, values of every non-native slot)`; each group is one Zernio
 * broadcast with those values as literals. Too many groups → one direct
 * send per recipient, when the campaign is small enough; else refused.
 */

/** Default broadcast partitions per campaign (`CAMPAIGN_MAX_PARTITIONS`). */
export const CAMPAIGN_MAX_PARTITIONS = 25;
/** Default reachable-recipient cap for direct sends (`CAMPAIGN_DIRECT_MAX`). */
export const CAMPAIGN_DIRECT_MAX = 5000;

type Env = Record<string, string | undefined>;

const positiveInt = (raw: string | undefined, fallback: number) => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

export const campaignMaxPartitions = (env: Env = process.env) => positiveInt(env.CAMPAIGN_MAX_PARTITIONS, CAMPAIGN_MAX_PARTITIONS);
export const campaignDirectMax = (env: Env = process.env) => positiveInt(env.CAMPAIGN_DIRECT_MAX, CAMPAIGN_DIRECT_MAX);

/**
 * sha256 hex of `[channelId, ...values of the non-native slots]`.
 * `values` are the resolved values in slot order (`resolveVarMap`), and
 * `slots` the map's slots in the same order (`slotsInOrder`).
 */
export function partitionKey(channelId: string | null, values: readonly string[], slots: readonly VarSlot[]): string {
  const parts: Array<string | null> = [channelId];
  slots.forEach((s, i) => {
    if (!isNativeSlot(s)) parts.push(values[i] ?? "");
  });
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** A map's slots in numeric slot order (the order `resolveVarMap` returns values in). */
export function slotsInOrder(map: VarMap): VarSlot[] {
  return slotKeys(map).map((k) => map[k]);
}

export type TransportKind = "broadcast" | "direct" | "too_varied";

/**
 * - `broadcast` when the partitions fit `CAMPAIGN_MAX_PARTITIONS`;
 * - else `direct` when `reachable <= CAMPAIGN_DIRECT_MAX`;
 * - else `too_varied` (launch refuses with `campaigns.var_map_too_varied`).
 * `headerOverride` (a campaign-level header file) forces direct sends
 * (controller ruling R8), so it is capped by `CAMPAIGN_DIRECT_MAX` too.
 */
export function planTransport(
  { partitions, reachable, headerOverride = false }: { partitions: number; reachable: number; headerOverride?: boolean },
  env: Env = process.env,
): TransportKind {
  if (!headerOverride && partitions <= campaignMaxPartitions(env)) return "broadcast";
  return reachable <= campaignDirectMax(env) ? "direct" : "too_varied";
}
