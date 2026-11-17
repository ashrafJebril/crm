/**
 * Which tab the AI agent page opens on (SP-20 live verification F3). Pure.
 *
 * The page must not choose before the member's permissions are known
 * (otherwise a cold load picks "tools", the only tab that needs nothing).
 * Once known: the tab named in the hash (`#/agent?tab=…`) when the member can
 * open it, else the first tab they can open in the page's order.
 */
export const AGENT_TABS = ["settings", "try", "skills", "knowledge", "tools", "mcp"] as const;
export type AgentTab = (typeof AGENT_TABS)[number];

export function isAgentTab(v: unknown): v is AgentTab {
  return typeof v === "string" && (AGENT_TABS as readonly string[]).includes(v);
}

/** The tabs this member sees, in order. */
export function availableAgentTabs(can: (p: "agent.view" | "agent.update" | "knowledge.view") => boolean): AgentTab[] {
  return [
    ...(can("agent.view") ? (["settings"] as const) : []),
    ...(can("agent.update") ? (["try"] as const) : []),
    ...(can("agent.view") ? (["skills"] as const) : []),
    ...(can("knowledge.view") ? (["knowledge"] as const) : []),
    "tools",
    "mcp",
  ];
}

/** The tab to show; null while permissions are still loading (show nothing yet). */
export function pickAgentTab(opts: { loading: boolean; available: AgentTab[]; requested?: string | null; chosen?: AgentTab | null }): AgentTab | null {
  if (opts.loading) return null;
  if (opts.chosen && opts.available.includes(opts.chosen)) return opts.chosen;
  if (isAgentTab(opts.requested) && opts.available.includes(opts.requested)) return opts.requested;
  return opts.available[0] ?? null;
}
