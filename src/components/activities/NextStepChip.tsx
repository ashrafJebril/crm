import { useMemo, type CSSProperties } from "react";
import { useFetch } from "@/api/useFetch";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { formatDue, type ActivityKind } from "@/screens/followups/followupsLogic";
import { useWorkspaceTz, kindLabel } from "./activityApi";

export interface NextStep {
  activityId: string;
  kind: ActivityKind;
  title: string;
  dueAt: string | null;
  overdue: boolean;
}
export type NextSteps = Record<string, NextStep | undefined>;

/** One batched request for a page/column of records (backend caps at 200 ids). */
export function useNextSteps(by: "contactIds" | "ticketIds", ids: string[]): NextSteps {
  const key = useMemo(() => [...new Set(ids)].sort().slice(0, 200).join(","), [ids]);
  const q = useFetch<NextSteps>(key ? `/activities/next-steps?${by}=${key}` : null);
  return q.data ?? {};
}

const chip: CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 4, maxWidth: "100%",
  padding: "2px 8px", borderRadius: 999, fontSize: 11, lineHeight: 1.5,
  border: "1px solid var(--line-soft)", background: "var(--bg-2)", color: "var(--ink-2)",
  fontFamily: "inherit",
};

export function NextStepChip({ step, onClick, canEdit = true }: {
  step: NextStep | undefined;
  onClick?: () => void;
  canEdit?: boolean;
}) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const tz = useWorkspaceTz();
  const label = step
    ? `${step.title || kindLabel(tx, step.kind)}${step.dueAt ? ` · ${formatDue(step.dueAt, new Date(), tz, t.lang)}` : ""}`
    : tx("No next step", "لا توجد خطوة تالية");
  const style: CSSProperties = step?.overdue
    ? { ...chip, color: "var(--bad)", borderColor: "color-mix(in srgb, var(--bad) 40%, transparent)", background: "color-mix(in srgb, var(--bad) 10%, transparent)" }
    : step ? chip : { ...chip, color: "var(--ink-3)", background: "transparent" };
  return (
    <button
      type="button"
      style={{ ...style, cursor: canEdit ? "pointer" : "default" }}
      disabled={!canEdit}
      title={step ? label : tx("Schedule a follow-up", "جدولة متابعة")}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); onClick?.(); }}
    >
      <span dir="auto" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
    </button>
  );
}
