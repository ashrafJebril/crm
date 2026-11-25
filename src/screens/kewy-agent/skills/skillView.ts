import type { Skill, SkillStatus } from "@/lib/types";
import type { Tx } from "@/lib/tx";
import { PROVIDER_NAME } from "./skillCatalog";

type Can = (permission: "agent.view" | "agent.update" | "agent.delete") => boolean;

export type PrimaryKind = "install" | "turn_on" | "settings" | "retry" | null;
export type SecondaryKind = "settings" | "update" | "turn_off" | "uninstall";
export type DisabledReason = "connect_first" | "not_connected" | "no_permission" | "needs_config" | null;

export interface CardView {
  statePill: { status: SkillStatus; tone: "ok" | "warn" | "bad" | "" };
  primaryAction: { kind: PrimaryKind; disabled: boolean; reason: DisabledReason };
  secondaryActions: SecondaryKind[];
  /** "Connect <provider> first" when the skill's connector is missing. */
  connectFirst: { provider: string } | null;
  updateBadge: boolean;
  readOnly: boolean;
}

/**
 * The card (and detail sheet) model for one skill. Mirrors the server's
 * rules so the UI never offers what the API refuses: a missing connector
 * disables install (the backend would only park it in needs_connector), an
 * unlinked agent disables install, and actions need agent.update (uninstall:
 * agent.delete). Viewers see the card read-only.
 */
export function cardView(skill: Skill, can: Can, agentConnected = true): CardView {
  const canUpdate = can("agent.update");
  const canDelete = can("agent.delete");
  const connectFirst = skill.requiredConnector && !skill.requiredConnector.connected ? { provider: skill.requiredConnector.provider } : null;
  const updateBadge = skill.installed && skill.updateAvailable && skill.installedVersion !== null && skill.installedVersion < skill.version;
  const tone: CardView["statePill"]["tone"] =
    skill.status === "enabled" ? "ok" : skill.status === "needs_attention" ? "bad" : skill.status === "needs_connector" ? "warn" : "";
  const statePill = { status: skill.status, tone };
  const readOnly = !canUpdate;

  let primary: CardView["primaryAction"] = { kind: null, disabled: true, reason: null };
  const secondary: SecondaryKind[] = [];
  const legacyEdited = skill.status === "needs_attention" && skill.attentionReason === "legacy_edited";

  switch (skill.status) {
    case "not_installed":
      primary = {
        kind: "install",
        disabled: !canUpdate || !!connectFirst || !agentConnected,
        reason: !canUpdate ? "no_permission" : connectFirst ? "connect_first" : !agentConnected ? "not_connected" : null,
      };
      break;
    case "enabled":
      primary = { kind: "settings", disabled: !canUpdate, reason: canUpdate ? null : "no_permission" };
      secondary.push("turn_off");
      break;
    case "disabled":
      primary = skill.needsConfig
        ? { kind: "settings", disabled: !canUpdate, reason: canUpdate ? "needs_config" : "no_permission" }
        : { kind: "turn_on", disabled: !canUpdate || !!connectFirst, reason: !canUpdate ? "no_permission" : connectFirst ? "connect_first" : null };
      if (!skill.needsConfig) secondary.push("settings");
      break;
    case "needs_connector":
      primary = { kind: null, disabled: true, reason: "connect_first" };
      secondary.push("settings");
      break;
    case "needs_attention":
      primary = { kind: "retry", disabled: !canUpdate, reason: canUpdate ? null : "no_permission" };
      secondary.push("settings");
      // Its old instructions are still in the prompt: no turning it off yet.
      if (!legacyEdited) secondary.push("turn_off");
      break;
  }
  if (updateBadge) secondary.unshift("update");
  if (skill.installed && !legacyEdited) secondary.push("uninstall");

  const allowed = secondary.filter((a) => (a === "uninstall" ? canDelete : canUpdate));
  return {
    statePill,
    primaryAction: primary,
    secondaryActions: readOnly && !canDelete ? [] : allowed,
    connectFirst,
    updateBadge,
    readOnly,
  };
}

export function statusLabel(status: SkillStatus, tx: Tx, provider?: string): string {
  switch (status) {
    case "not_installed":
      return tx("Not installed", "غير مثبتة");
    case "enabled":
      return tx("On", "مفعّلة");
    case "disabled":
      return tx("Off", "متوقفة");
    case "needs_connector": {
      const name = PROVIDER_NAME[provider ?? ""] ?? provider ?? "";
      return tx(`Connect ${name} first`, `اربط ${name} أولًا`);
    }
    case "needs_attention":
      return tx("Needs attention", "تحتاج انتباهًا");
  }
}

export function reasonText(reason: DisabledReason, tx: Tx, provider?: string): string | null {
  const name = PROVIDER_NAME[provider ?? ""] ?? provider ?? "";
  switch (reason) {
    case "connect_first":
      return tx(`Connect ${name} first. Until then this skill stays off.`, `اربط ${name} أولًا. حتى ذلك الحين تبقى هذه المهارة متوقفة.`);
    case "not_connected":
      return tx("Connect this workspace to a Kewy AI agent first.", "اربط مساحة العمل هذه بوكيل كيوي الذكاء أولًا.");
    case "no_permission":
      return tx("You can view this skill but not change it.", "يمكنك عرض هذه المهارة دون تعديلها.");
    case "needs_config":
      return tx("Fill in the required settings to turn it on.", "أكمل الإعدادات المطلوبة لتفعيلها.");
    default:
      return null;
  }
}

/** Latin digits in both languages. */
const n = (v: number) => new Intl.NumberFormat("en-US").format(v);

export function usageText(skill: Skill, tx: Tx): string {
  const c = skill.usage.calls7d;
  if (c === 0) return tx("Not used in the last 7 days", "لم تُستخدم خلال آخر 7 أيام");
  return tx(`Used ${n(c)} times in 7 days`, `استُخدمت ${n(c)} مرة خلال 7 أيام`);
}

export function usedBy(skill: Skill, tx: Tx): string | null {
  if (!skill.agents.length) return null;
  return tx(`Used by ${skill.agents.map((a) => a.name.en).join(", ")}`, `يستخدمها ${skill.agents.map((a) => a.name.ar).join("، ")}`);
}

export type SkillFilter = "all" | "installed" | "available";
export function filterSkills(skills: Skill[], f: SkillFilter): Skill[] {
  if (f === "installed") return skills.filter((s) => s.installed);
  if (f === "available") return skills.filter((s) => !s.installed);
  return skills;
}
