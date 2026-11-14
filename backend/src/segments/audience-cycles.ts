/**
 * SP-16 cycle and expansion checks for smart → smart references (ruling 5).
 *
 * `assertNoCycle` walks breadth-first from the tree being saved through every
 * smart audience it reaches, loading one level per query, with the saved id
 * standing for the new tree. A path back to the saved id is a 400
 * `audiences.rule_cycle {path}`. The save holds the workspace advisory lock,
 * so two crossing saves cannot both pass.
 */
import { audienceError } from "./audience-errors";
import { AUDIENCE_LIMITS, isGroup, referencedIds, type AudienceGroup, type AudienceRules } from "./audience-rules";

/** Loads the smart (`crm`) audiences among `ids` (workspace-scoped). Non-smart ids are absent. */
export type LoadSmart = (ids: string[]) => Promise<Map<string, AudienceRules>>;

/** Safety bound on the walk (the expansion cap stops real trees long before it). */
const MAX_LEVELS = 32;

/**
 * Throws `audiences.rule_cycle {path: [self, …, self]}` when `tree` (the new
 * tree of `selfId`) reaches `selfId` through smart references. `known` holds
 * origins already loaded (the save's lookups): an id known to be manual or
 * hjz never starts a walk. Returns every smart tree loaded (for the
 * expansion check).
 */
export async function assertNoCycle(
  ws: string,
  selfId: string | null,
  tree: AudienceRules,
  loadSmart: LoadSmart,
  known?: ReadonlyMap<string, { origin: string }>,
): Promise<Map<string, AudienceRules>> {
  void ws; // loadSmart is workspace-scoped by its caller
  const trees = new Map<string, AudienceRules>();
  const parent = new Map<string, string | null>();
  const smartRefs = (t: AudienceGroup) =>
    referencedIds(t).segmentIds.filter((id) => {
      const k = known?.get(id);
      return !k || k.origin === "crm" || id === selfId;
    });

  const self = selfId ?? "\u0000new";
  const pathTo = (id: string): string[] => {
    const out: string[] = [];
    for (let cur: string | null | undefined = id; cur; cur = parent.get(cur) ?? null) out.unshift(cur);
    return out;
  };

  parent.set(self, null);
  let frontier: string[] = [];
  for (const id of smartRefs(tree)) {
    if (id === selfId) throw audienceError("audiences.rule_cycle", { path: [self, self] });
    if (!parent.has(id)) {
      parent.set(id, self);
      frontier.push(id);
    }
  }
  for (let level = 0; frontier.length && level < MAX_LEVELS; level++) {
    const loaded = await loadSmart(frontier);
    const next: string[] = [];
    for (const id of frontier) {
      const t = loaded.get(id);
      if (!t) continue; // manual, hjz or gone: no outgoing edges
      trees.set(id, t);
      for (const ref of smartRefs(t)) {
        if (ref === selfId) throw audienceError("audiences.rule_cycle", { path: [...pathTo(id), self] });
        if (parent.has(ref)) continue; // already reached (diamond) or a stored cycle not through self
        parent.set(ref, id);
        next.push(ref);
      }
    }
    frontier = next;
  }
  return trees;
}

/**
 * Leaf conditions after inlining every referenced smart audience (a diamond
 * counts once per path, as the compiler inlines it). Over
 * `AUDIENCE_LIMITS.maxExpanded` → 400 `audiences.rules_too_large {max: 100}`.
 */
export function assertExpansionWithinLimit(tree: AudienceRules, trees: ReadonlyMap<string, AudienceRules>): number {
  const max = AUDIENCE_LIMITS.maxExpanded;
  const memo = new Map<string, number>();
  const size = (g: AudienceGroup, stack: Set<string>): number => {
    let n = 0;
    for (const c of g.rules) {
      if (isGroup(c)) n += size(c, stack);
      else if (c.field === "group" && !c.missing && trees.has(c.segmentId) && !stack.has(c.segmentId)) {
        const id = c.segmentId;
        let s = memo.get(id);
        if (s === undefined) {
          s = size(trees.get(id)!, new Set([...stack, id]));
          memo.set(id, s);
        }
        n += s;
      } else n += 1;
      if (n > max) throw audienceError("audiences.rules_too_large", { max });
    }
    return n;
  };
  return size(tree, new Set());
}
