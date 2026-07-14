import type { TicketStage } from "@/lib/types";

/** Single source of truth for the stage color palette across the pipeline. */
export const stageColor: Record<TicketStage["color"], string> = {
  ink: "var(--ink-3)",
  info: "var(--info, #3b82f6)",
  ok: "var(--ok, #10b981)",
  warn: "var(--warn, #f59e0b)",
  bad: "var(--bad, #ef4444)",
  accent: "var(--accent)",
  human: "var(--human, #8b5cf6)",
};
