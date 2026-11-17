import { useState } from "react";
import { api, ApiError } from "@/api/client";
import { useToast } from "@/components/Toast";
import type { Skill } from "@/lib/types";
import type { Tx } from "@/lib/tx";
import { droppedNotice } from "./skillConfigForm";
import { fieldErrorsOf, skillErrorKey, skillErrorText } from "./skillErrors";

export type SkillAction =
  | { kind: "install"; config?: Record<string, unknown> }
  | { kind: "save"; config: Record<string, unknown> }
  | { kind: "turn_on" }
  | { kind: "turn_off" }
  | { kind: "update" }
  | { kind: "retry" }
  | { kind: "uninstall" };

const path = (s: Skill) => `/skills/${encodeURIComponent(s.key)}`;

/**
 * SP-22: every skill write, with the shared error handling. PATCH and update
 * send the ledger row's `rowVersion`; a 409 `skills.version_conflict` reloads
 * the list and says someone else changed the skill; `skills.invalid_config`
 * returns its field errors to the form; a 403 shows the shared no-permission
 * copy. Returns true on success.
 */
export function useSkillActions(tx: Tx, reload: () => Promise<void> | void) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const run = async (skill: Skill, action: SkillAction): Promise<boolean> => {
    setBusy(`${skill.key}:${action.kind}`);
    setFieldErrors({});
    try {
      switch (action.kind) {
        case "install":
          await api.post(`${path(skill)}/install`, action.config ? { config: action.config } : {});
          toast(tx("Skill installed", "ثُبّتت المهارة"), "success");
          break;
        case "save":
          await api.patch(path(skill), { config: action.config, version: skill.rowVersion });
          toast(tx("Settings saved", "حُفظت الإعدادات"), "success");
          break;
        case "turn_on":
        case "turn_off":
          await api.patch(path(skill), { enabled: action.kind === "turn_on", version: skill.rowVersion });
          toast(action.kind === "turn_on" ? tx("Skill turned on", "فُعّلت المهارة") : tx("Skill turned off", "أُوقفت المهارة"), "success");
          break;
        case "update": {
          const res = await api.post<{ dropped?: string[] }>(`${path(skill)}/update`, { version: skill.rowVersion });
          const notice = droppedNotice(res?.dropped ?? [], tx);
          toast(notice ?? tx("Skill updated", "حُدّثت المهارة"), notice ? "info" : "success");
          break;
        }
        case "retry":
          await api.post(`${path(skill)}/retry`);
          toast(tx("Skill applied again", "أُعيد تطبيق المهارة"), "success");
          break;
        case "uninstall":
          await api.delete(path(skill));
          toast(tx("Skill uninstalled", "أُزيلت المهارة"), "success");
          break;
      }
      await reload();
      return true;
    } catch (e) {
      const key = skillErrorKey(e);
      if (key === "skills.invalid_config") setFieldErrors(fieldErrorsOf(e, tx));
      toast(skillErrorText(e, tx), "error");
      // Someone else changed it (or its state moved on): show the fresh row.
      if (key === "skills.version_conflict" || (e instanceof ApiError && e.status === 409)) await reload();
      return false;
    } finally {
      setBusy(null);
    }
  };

  return { run, busy, fieldErrors, setFieldErrors };
}
