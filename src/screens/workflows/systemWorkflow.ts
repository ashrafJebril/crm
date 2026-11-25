/**
 * SP-24 system workflows (`Workflow.systemKey = "lifecycle.<key>"`): managed
 * in Settings → Automatic messages. The generic routes answer 409
 * `workflows.system_locked`, so the builder and list show them read-only.
 */
import type { Workflow, WorkflowTriggerType } from "@/lib/types";
import { STEP_META, TRIGGER_META, TRIGGER_ORDER, type StepGroup } from "./stepMeta";

export const AUTOMATIC_MESSAGES_HREF = "#/settings?tab=automaticMessages";

export const MANAGED_BADGE: [string, string] = ["Managed in Automatic messages", "تُدار من الرسائل التلقائية"];

export const isSystemWorkflow = (wf: Pick<Workflow, "systemKey"> | null | undefined): boolean => !!wf?.systemKey;

/** A step type's label, also for step types only system workflows use (e.g. `notify_staff`). */
export function stepLabel(type: string): [string, string] {
  const meta = (STEP_META as Record<string, { en: string; ar: string } | undefined>)[type];
  if (meta) return [meta.en, meta.ar];
  if (type === "notify_staff") return ["Notify the team", "تنبيه الفريق"];
  return [type.replace(/_/g, " "), type.replace(/_/g, " ")];
}

/** A step type's colour group; an unknown type (e.g. a system-only step) reads as "message". */
export function stepGroup(type: string): StepGroup {
  const meta = (STEP_META as Record<string, { group: StepGroup } | undefined>)[type];
  return meta?.group ?? "message";
}

/** A trigger's labels, with a neutral fallback for a type this build doesn't know. */
export function triggerMeta(type: string): { en: string; ar: string; descEn: string; descAr: string } {
  const meta = (TRIGGER_META as Record<string, { en: string; ar: string; descEn: string; descAr: string } | undefined>)[type];
  if (meta) return meta;
  const words = type.replace(/_/g, " ");
  return { en: words, ar: words, descEn: "", descAr: "" };
}

/**
 * `#/workflows?new=1&trigger=<type>` (from "Custom automations"): the trigger
 * a new user workflow starts with, or null. Only user triggers are accepted.
 */
export function newWorkflowTrigger(hash: string): WorkflowTriggerType | null {
  const q = hash.split("?")[1] ?? "";
  const p = new URLSearchParams(q);
  if (p.get("new") !== "1") return null;
  const t = p.get("trigger");
  return t && (TRIGGER_ORDER as string[]).includes(t) ? (t as WorkflowTriggerType) : null;
}

/** The hash without the one-shot `new` / `trigger` params. */
export function withoutNewParams(hash: string): string {
  const [path, q = ""] = hash.split("?");
  const p = new URLSearchParams(q);
  p.delete("new");
  p.delete("trigger");
  const rest = p.toString();
  return rest ? `${path}?${rest}` : path;
}
