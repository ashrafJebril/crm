import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ApiError } from "@/api/client";
import { useAuth } from "@/auth/context";
import { useFetch } from "@/api/useFetch";
import type { Tx } from "@/lib/tx";
import type { TeamMember } from "@/lib/types";
import type { ActivityKind } from "@/screens/followups/followupsLogic";

export const FALLBACK_TZ = "Asia/Riyadh";

/** The active workspace's IANA timezone (all due times are shown/entered in it). */
export function useWorkspaceTz(): string {
  const { activeWorkspace } = useAuth();
  return activeWorkspace?.timezone || FALLBACK_TZ;
}

export const KINDS: ActivityKind[] = ["follow_up", "call", "meeting", "task", "note_log"];

export function kindLabel(tx: Tx, k: ActivityKind): string {
  switch (k) {
    case "follow_up": return tx("Follow-up", "متابعة");
    case "call": return tx("Call", "مكالمة");
    case "meeting": return tx("Meeting", "اجتماع");
    case "task": return tx("Task", "مهمة");
    case "note_log": return tx("Note", "ملاحظة");
  }
}

export const kindGlyph: Record<ActivityKind, string> = {
  follow_up: "↻", call: "☎", meeting: "◷", task: "☑", note_log: "✎",
};

/** Kinds that must carry a due time. */
export const needsDue = (k: ActivityKind) => k === "follow_up" || k === "task";

export function useTeam(): TeamMember[] {
  return useFetch<TeamMember[]>("/team").data ?? [];
}

/** Refresh every activity-derived view: queues, lists, next-step chips, timelines. */
export function invalidateActivities(qc: QueryClient): void {
  void qc.invalidateQueries({
    predicate: (q) => {
      const k = q.queryKey[0];
      return typeof k === "string" && (k.startsWith("/activities") || k === "contact-timeline");
    },
  });
}

export function useInvalidateActivities(): () => void {
  const qc = useQueryClient();
  return () => invalidateActivities(qc);
}

/** User-facing text for an API failure (known keys get real Arabic). */
export function activityError(tx: Tx, e: unknown): string {
  const msg = e instanceof ApiError ? e.message : e instanceof Error ? e.message : "";
  if (msg.includes("activities.assignee_no_access")) {
    return tx(
      "That person can't open this record, so it can't be assigned to them.",
      "لا يستطيع هذا الشخص فتح هذا السجل، لذلك لا يمكن إسناده إليه.",
    );
  }
  if (e instanceof ApiError && e.status === 403) {
    return tx("You don't have permission to do this", "ليست لديك صلاحية للقيام بذلك");
  }
  return msg || tx("Something went wrong. Try again.", "حدث خطأ ما. حاول مرة أخرى.");
}
