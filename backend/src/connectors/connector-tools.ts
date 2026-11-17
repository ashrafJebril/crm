import { catalogEntry, type ToolKind } from "./connector-catalog";

export type ToolAccess = "off" | "read" | "write";
/** Why a re-scan switched a tool off (shown until the owner switches it again). */
export type ToolFlag = "reclassified" | "description_changed" | "schema_changed";

/** One tool as stored in `Connector.tools`. */
export interface StoredTool {
  name: string;
  title?: string | null;
  description: string;
  kind: ToolKind;
  access: ToolAccess;
  inputSchema: unknown;
  removedAt?: string | null;
  /** Custom connectors: the owner explicitly marked this tool read-only. */
  ownerRead?: boolean;
  flag?: ToolFlag | null;
}

/** A tool as the upstream `tools/list` returns it. */
export interface UpstreamTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean; title?: string } | null;
}

/**
 * Hardening review: the vendor's `readOnlyHint` is NOT trusted for custom
 * connectors: every custom tool is "write" unless the owner marks it read.
 * A curated provider uses our catalogue's own classification first, then
 * the vendor hint, else "write".
 */
export function kindOf(tool: UpstreamTool, provider: string, ownerRead = false): ToolKind {
  if (provider === "custom") return ownerRead ? "read" : "write";
  const curated = catalogEntry(provider)?.kindOverrides?.[tool.name];
  if (curated) return curated;
  return tool.annotations?.readOnlyHint === true ? "read" : "write";
}

/**
 * The exposure rule (Review Focus 1): a tool is exposed iff it is switched on,
 * not removed, and either a read tool or switched to "write". `read` on a
 * write tool exposes nothing.
 */
export function isExposed(tool: Pick<StoredTool, "access" | "kind" | "removedAt">): boolean {
  if (tool.access === "off" || tool.removedAt) return false;
  return tool.access === "write" || tool.kind === "read";
}

/** Reads `Connector.tools` defensively (a malformed row exposes nothing). */
export function storedTools(raw: unknown): StoredTool[] {
  if (!Array.isArray(raw)) return [];
  const out: StoredTool[] = [];
  for (const t of raw) {
    if (!t || typeof t !== "object") continue;
    const r = t as Record<string, unknown>;
    if (typeof r.name !== "string" || !r.name) continue;
    const kind: ToolKind = r.kind === "read" ? "read" : "write";
    const access: ToolAccess = r.access === "read" || r.access === "write" ? r.access : "off";
    out.push({
      name: r.name,
      title: typeof r.title === "string" ? r.title : null,
      description: typeof r.description === "string" ? r.description : "",
      kind,
      access,
      inputSchema: r.inputSchema ?? { type: "object" },
      removedAt: typeof r.removedAt === "string" ? r.removedAt : null,
      ownerRead: r.ownerRead === true,
      flag: r.flag === "reclassified" || r.flag === "description_changed" || r.flag === "schema_changed" ? r.flag : null,
    });
  }
  return out;
}

const schemaKey = (s: unknown) => JSON.stringify(s ?? null);

/**
 * First scan: every tool starts off, except a curated provider's default-on
 * READ tools (custom connectors: all off, ruling 5).
 */
export function initialTools(upstream: UpstreamTool[], provider: string): StoredTool[] {
  const on = new Set(catalogEntry(provider)?.defaultOn ?? []);
  return upstream.map((u) => {
    const kind = kindOf(u, provider);
    return {
      name: u.name,
      title: u.title ?? u.annotations?.title ?? null,
      description: u.description ?? "",
      kind,
      access: provider !== "custom" && kind === "read" && on.has(u.name) ? "read" : "off",
      inputSchema: u.inputSchema ?? { type: "object" },
      removedAt: null,
      ownerRead: false,
      flag: null,
    };
  });
}

/**
 * Re-scan (ruling 6, hardened): new tools arrive off; vanished tools are
 * flagged `removedAt` (kept, never exposed); returning tools are un-flagged
 * with their old switch. An ENABLED tool is switched off and flagged when:
 *  - its kind changed (either way: a write→read reclassification must not
 *    keep it on) → "reclassified";
 *  - its description changed (descriptions are an instruction channel) →
 *    "description_changed";
 *  - it is a write tool whose schema changed → "schema_changed".
 * A read tool whose schema alone changed keeps its switch.
 */
export function applyRescan(
  old: StoredTool[],
  upstream: UpstreamTool[],
  provider: string,
  now: Date = new Date(),
): { tools: StoredTool[]; added: string[]; removed: string[]; changed: string[] } {
  const byName = new Map(old.map((t) => [t.name, t]));
  const seen = new Set<string>();
  const tools: StoredTool[] = [];
  const added: string[] = [];
  const changed: string[] = [];
  for (const u of upstream) {
    if (seen.has(u.name)) continue;
    seen.add(u.name);
    const prev = byName.get(u.name);
    const ownerRead = prev?.ownerRead === true;
    const kind = kindOf(u, provider, ownerRead);
    const next: StoredTool = {
      name: u.name,
      title: u.title ?? u.annotations?.title ?? null,
      description: u.description ?? "",
      kind,
      access: prev ? prev.access : "off",
      inputSchema: u.inputSchema ?? { type: "object" },
      removedAt: null,
      ownerRead,
      flag: prev?.flag ?? null,
    };
    if (!prev) {
      added.push(u.name);
    } else {
      const schemaChanged = schemaKey(prev.inputSchema) !== schemaKey(next.inputSchema);
      const descChanged = prev.description !== next.description;
      const kindChanged = prev.kind !== kind;
      if (schemaChanged || descChanged || kindChanged) {
        changed.push(u.name);
        const flag: ToolFlag | null = kindChanged ? "reclassified" : descChanged ? "description_changed" : schemaChanged && kind === "write" ? "schema_changed" : null;
        if (flag && next.access !== "off") {
          next.access = "off";
          next.flag = flag;
        }
      }
    }
    tools.push(next);
  }
  const removed: string[] = [];
  for (const t of old) {
    if (seen.has(t.name)) continue;
    if (!t.removedAt) removed.push(t.name);
    tools.push({ ...t, removedAt: t.removedAt ?? now.toISOString() });
  }
  return { tools, added, removed, changed };
}

export class ToolPatchError extends Error {
  constructor(public readonly code: "invalid_tools" | "tool_removed" | "write_access_requires_manage", public readonly tool?: string) {
    super(code);
  }
}

export interface ToolPatchEntry {
  name: string;
  access: ToolAccess;
  /** Custom connectors only: the owner's classification (needs connectors.manage). */
  kind?: ToolKind;
}

/**
 * Applies `{name, access, kind?}` switches. Unknown tools → invalid_tools; a
 * removed tool → tool_removed; turning a WRITE tool to "write", or marking a
 * custom tool read (or write), needs connectors.manage (ruling 11) →
 * write_access_requires_manage. `kind` is accepted only on custom
 * connectors. Touching a tool clears its re-scan flag.
 */
export function applyPatch(tools: StoredTool[], patch: ToolPatchEntry[], canManage: boolean, provider = "custom"): StoredTool[] {
  const byName = new Map(tools.map((t) => [t.name, { ...t }]));
  for (const p of patch) {
    const t = byName.get(p.name);
    if (!t) throw new ToolPatchError("invalid_tools", p.name);
    if (!["off", "read", "write"].includes(p.access)) throw new ToolPatchError("invalid_tools", p.name);
    if (t.removedAt && p.access !== "off") throw new ToolPatchError("tool_removed", p.name);
    if (p.kind !== undefined) {
      if (provider !== "custom" || (p.kind !== "read" && p.kind !== "write")) throw new ToolPatchError("invalid_tools", p.name);
      if (p.kind !== t.kind) {
        if (!canManage) throw new ToolPatchError("write_access_requires_manage", p.name);
        t.kind = p.kind;
        t.ownerRead = p.kind === "read";
      }
    }
    if (t.kind === "write" && p.access === "write" && t.access !== "write" && !canManage) {
      throw new ToolPatchError("write_access_requires_manage", p.name);
    }
    t.access = p.access;
    t.flag = null;
  }
  return tools.map((t) => byName.get(t.name) as StoredTool);
}
