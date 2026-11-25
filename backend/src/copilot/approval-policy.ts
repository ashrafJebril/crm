/**
 * SP-18 approval policy (ruling 3, Review Focus 2). Pure: decides whether a
 * proposed write may apply without the member's click. Order, first match wins:
 *
 *  1. an unknown mode is treated as `manual` (the mode comes from the client
 *     every turn and is never trusted beyond the allow-list);
 *  2. `manual` → confirm;
 *  3. high risk (a terminal stage move, a knowledge save) → confirm in every mode;
 *  4. a tainted session (customer-written or outside content was read) → confirm in every mode;
 *  5. `auto` → apply only tools on AUTO_APPLY_TOOLS at low or medium risk;
 *  6. `agent_decides` → apply only low-risk tools on the allow-list;
 *  7. anything else → confirm.
 */
import { APPROVAL_MODES, AUTO_APPLY_TOOLS, type ApprovalMode } from "./copilot-constants";
import type { ToolRisk } from "./copilot-tools/registry";

export type PolicyReason = "manual" | "high_risk" | "tainted" | "auto_allowed" | "not_allowed" | "agent_decides_low";

export interface PolicyDecision {
  apply: boolean;
  reason: PolicyReason;
}

export function normalizeMode(mode: unknown): ApprovalMode {
  return (APPROVAL_MODES as readonly string[]).includes(mode as string) ? (mode as ApprovalMode) : "manual";
}

export function decideApproval(input: { mode: unknown; tool: string; risk: ToolRisk; tainted: boolean }): PolicyDecision {
  const mode = normalizeMode(input.mode);
  if (mode === "manual") return { apply: false, reason: "manual" };
  if (input.risk === "high") return { apply: false, reason: "high_risk" };
  if (input.tainted) return { apply: false, reason: "tainted" };
  const allowed = (AUTO_APPLY_TOOLS as readonly string[]).includes(input.tool);
  if (mode === "auto") return allowed ? { apply: true, reason: "auto_allowed" } : { apply: false, reason: "not_allowed" };
  // agent_decides
  return allowed && input.risk === "low" ? { apply: true, reason: "agent_decides_low" } : { apply: false, reason: "not_allowed" };
}
