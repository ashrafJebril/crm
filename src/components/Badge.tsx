import type { ReactNode } from "react";
import type { Campaign } from "@/lib/types";

export type BadgeKind = "" | "accent" | "human" | "ok" | "warn" | "bad" | "info";

interface BadgeProps {
  kind?: BadgeKind;
  dot?: boolean;
  children: ReactNode;
}

export const Badge = ({ kind = "", dot, children }: BadgeProps) => (
  <span className={`badge ${kind}`.trim()}>
    {dot && <span className="dot" />}
    {children}
  </span>
);

export const statusKind = (s: Campaign["status"]): BadgeKind =>
  ({ running: "ok", scheduled: "info", draft: "", completed: "", paused: "warn" } as const)[s] ?? "";
