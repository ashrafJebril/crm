/**
 * SP-18 approval mode (ruling 3): remembered per member in this browser
 * (`localStorage`, wrapped: a blocked storage just means Manual), sent with
 * every turn and checked by the server, which never trusts it for high-risk
 * writes or in a chat that read customer data.
 */
import type { CopilotApprovalMode } from "@/lib/types";
import { APPROVAL_MODES, DEFAULT_APPROVAL_MODE } from "./copilotConstants";

const KEY = (userId: string) => `aram.copilot.mode.v1.${userId}`;

export function isApprovalMode(v: unknown): v is CopilotApprovalMode {
  return typeof v === "string" && (APPROVAL_MODES as readonly string[]).includes(v);
}

export function readApprovalMode(userId: string | null | undefined, storage: Pick<Storage, "getItem"> | null = safeStorage()): CopilotApprovalMode {
  if (!userId || !storage) return DEFAULT_APPROVAL_MODE;
  try {
    const v = storage.getItem(KEY(userId));
    return isApprovalMode(v) ? v : DEFAULT_APPROVAL_MODE;
  } catch {
    return DEFAULT_APPROVAL_MODE;
  }
}

export function writeApprovalMode(userId: string | null | undefined, mode: CopilotApprovalMode, storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
  if (!userId || !storage || !isApprovalMode(mode)) return;
  try {
    storage.setItem(KEY(userId), mode);
  } catch {
    /* blocked: the mode lives for this page only */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Labels (ruling-3 copy) and the plain rule shown under the picker. */
export const MODE_LABELS: Record<CopilotApprovalMode, [en: string, ar: string]> = {
  manual: ["Confirm every change", "أكّد كل تغيير"],
  agent_decides: ["Confirm risky or unclear changes", "أكّد التغييرات الحساسة أو غير الواضحة"],
  auto: ["Apply safe changes automatically", "طبّق التغييرات الآمنة تلقائيًا"],
};
export const TAINT_RULE: [en: string, ar: string] = [
  "Once this chat has read customer data, every change asks you first.",
  "بعد أن تقرأ هذه المحادثة بيانات العملاء، يطلب كل تغيير موافقتك أولًا.",
];
