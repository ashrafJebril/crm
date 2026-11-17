/**
 * SP-22 skill state (pure): the ledger rows plus the catalog's defaults, the
 * enabled set the MCP server builds tools from, and the composition of the
 * live prompt (owner text untouched, then one delimited block per enabled
 * skill, in catalog order).
 */
import {
  LEGACY_SECTIONS,
  SKILL_CATALOG,
  defaultConfig,
  type SkillCatalog,
  type SkillConfig,
  type SkillKey,
} from "./skill-catalog";
import { renderSkillPrompt } from "./skill-config";

export type SkillStatus = "enabled" | "disabled" | "needs_connector" | "needs_attention";

export interface SkillRow {
  id?: string;
  skillKey: string;
  installedVersion: number;
  status: string;
  config: unknown;
  needsConfig: boolean;
  lastAppliedAt?: Date | null;
  lastError?: string | null;
  version: number;
}

export interface SkillState {
  key: SkillKey;
  installed: boolean;
  status: SkillStatus | "not_installed";
  installedVersion: number | null;
  config: SkillConfig;
  needsConfig: boolean;
  lastError: string | null;
  /** The row's optimistic-concurrency version (0 for a rowless default). */
  version: number;
  row: SkillRow | null;
}

/** Skill key → the config its tools and block use. */
export type EnabledSkills = ReadonlyMap<SkillKey, { version: number; config: SkillConfig }>;

const asConfig = (c: unknown): SkillConfig => (c && typeof c === "object" && !Array.isArray(c) ? (c as SkillConfig) : {});

/** Every catalog skill's state. A missing row of a default skill = enabled at v1, default config (ruling 3). */
export function resolveSkillStates(rows: readonly SkillRow[], catalog: SkillCatalog = SKILL_CATALOG): SkillState[] {
  const byKey = new Map(rows.map((r) => [r.skillKey, r]));
  return catalog.map((entry) => {
    const row = byKey.get(entry.key) ?? null;
    if (!row) {
      return entry.defaultInstalled
        ? { key: entry.key, installed: true, status: "enabled", installedVersion: 1, config: defaultConfig(entry), needsConfig: false, lastError: null, version: 0, row: null }
        : { key: entry.key, installed: false, status: "not_installed", installedVersion: null, config: {}, needsConfig: false, lastError: null, version: 0, row: null };
    }
    return {
      key: entry.key,
      installed: true,
      status: (row.status as SkillStatus) ?? "enabled",
      installedVersion: row.installedVersion,
      config: asConfig(row.config),
      needsConfig: row.needsConfig,
      lastError: row.lastError ?? null,
      version: row.version,
      row,
    };
  });
}

/** Tools and blocks are on for enabled skills, and for needs_attention ones
 *  (wanted on; only the last prompt apply failed). */
export function isActive(status: SkillState["status"]): boolean {
  return status === "enabled" || status === "needs_attention";
}

export function enabledFromStates(states: readonly SkillState[]): EnabledSkills {
  const m = new Map<SkillKey, { version: number; config: SkillConfig }>();
  for (const s of states) if (isActive(s.status)) m.set(s.key, { version: s.installedVersion ?? 1, config: s.config });
  return m;
}

/** The enabled set with no rows at all (today's behaviour). */
export function defaultEnabled(catalog: SkillCatalog = SKILL_CATALOG): EnabledSkills {
  return enabledFromStates(resolveSkillStates([], catalog));
}

const BLOCK_RE = /(\n\n)?<!-- kewy-skill:([a-z_]+):v\d+ -->\n[\s\S]*?\n<!-- \/kewy-skill:\2 -->/g;
/** Never in a prompt (config text has control characters stripped). */
const PLACEHOLDER = "\u0000kewy-skills\u0000";

function removeOnce(s: string, text: string): string | null {
  const withSep = `\n\n${text}`;
  const i = s.indexOf(withSep);
  if (i >= 0) return s.slice(0, i) + s.slice(i + withSep.length);
  const j = s.indexOf(text);
  if (j < 0) return null;
  let out = s.slice(0, j) + s.slice(j + text.length);
  // A section at the very start leaves the next one's separator behind.
  if (j === 0 && out.startsWith("\n\n")) out = out.slice(2);
  return out;
}

/**
 * The live prompt with exactly these blocks (catalog order): every existing
 * kewy-skill block is removed, the exact legacy sections are migrated (an
 * edited legacy section is left and reported, and its skill gets no block),
 * the owner's text is kept byte for byte, and the blocks are written where
 * the first block was (appended when there was none).
 */
export function composeSkillPrompt(
  current: string,
  enabled: EnabledSkills,
  catalog: SkillCatalog = SKILL_CATALOG,
): { prompt: string; legacyEdited: SkillKey[] } {
  // Our blocks stay where the first one was: content written after them (the
  // owner's, SP-20's persona, SP-21's knowledge) keeps its order, so a second
  // apply changes nothing.
  let first = true;
  let s = current.replace(BLOCK_RE, (_m: string, sep: string | undefined) => {
    if (!first) return "";
    first = false;
    return `${sep ?? ""}${PLACEHOLDER}`;
  });
  // A skill with any edited legacy section keeps all of its legacy text (and
  // gets no block): removing only its exact parts would lose instructions.
  const legacyEdited = new Set<SkillKey>();
  for (const legacy of LEGACY_SECTIONS) {
    if (s.includes(legacy.marker) && !s.includes(legacy.text)) legacyEdited.add(legacy.skill);
  }
  for (const legacy of LEGACY_SECTIONS) {
    if (legacyEdited.has(legacy.skill)) continue;
    const next = removeOnce(s, legacy.text);
    if (next !== null) s = next;
  }
  const blocks: string[] = [];
  for (const entry of catalog) {
    const on = enabled.get(entry.key);
    if (!on || legacyEdited.has(entry.key)) continue;
    const block = renderSkillPrompt(entry, on.config, on.version);
    if (block) blocks.push(block);
  }
  const joined = blocks.join("\n\n");
  const edited = [...legacyEdited];
  if (s.includes(PLACEHOLDER)) {
    if (joined) return { prompt: s.replace(PLACEHOLDER, joined), legacyEdited: edited };
    if (s.includes(`\n\n${PLACEHOLDER}`)) return { prompt: s.replace(`\n\n${PLACEHOLDER}`, ""), legacyEdited: edited };
    let out = s.replace(PLACEHOLDER, "");
    if (out.startsWith("\n\n")) out = out.slice(2); // the blocks were first: drop the separator after them
    return { prompt: out, legacyEdited: edited };
  }
  const prompt = !joined ? s : s === "" ? joined : `${s}\n\n${joined}`;
  return { prompt, legacyEdited: edited };
}

/** The rows of one workspace through any Prisma-like delegate. */
export async function loadSkillRows(db: { skillInstall: { findMany: (a: object) => Promise<unknown[]> } }, workspaceId: string): Promise<SkillRow[]> {
  return (await db.skillInstall.findMany({ where: { workspaceId } })) as SkillRow[];
}
