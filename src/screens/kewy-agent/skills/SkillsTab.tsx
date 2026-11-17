import { useState } from "react";
import { useFetch } from "@/api/useFetch";
import { usePermissions } from "@/auth/usePermissions";
import { Badge } from "@/components/Badge";
import { IconCal, IconGlobe, IconInbox, IconLayers, IconTag, IconUsers } from "@/icons";
import type { Skill, SkillList } from "@/lib/types";
import type { Tx } from "@/lib/tx";
import { SKILL_ICON, type SkillIcon } from "./skillCatalog";
import { cardView, filterSkills, reasonText, statusLabel, usageText, usedBy, type SkillFilter } from "./skillView";
import { SkillDetailSheet, UNINSTALL_CONFIRM, actionLabel, quickActionLabel, turnOffConfirmText } from "./SkillDetailSheet";
import { useSkillActions } from "./useSkillActions";

const ICONS: Record<SkillIcon, (p: { w?: number }) => React.ReactElement> = {
  cal: IconCal,
  users: IconUsers,
  image: IconLayers,
  ticket: IconInbox,
  tag: IconTag,
  link: IconGlobe,
};

const FILTERS: Array<{ id: SkillFilter; en: string; ar: string }> = [
  { id: "all", en: "All", ar: "الكل" },
  { id: "installed", en: "Installed", ar: "المثبتة" },
  { id: "available", en: "Available", ar: "المتاحة" },
];

/**
 * SP-22: the skills gallery. `GET /skills` lists the catalog with each
 * skill's state; cards show the state pill, who uses it, its 7-day usage and
 * "Update available". Install / turn on / update / retry need agent.update,
 * uninstall agent.delete; viewers (agent.view) see read-only cards.
 */
export function SkillsTab({ tx, lang }: { tx: Tx; lang: "en" | "ar" }) {
  const { can } = usePermissions();
  const q = useFetch<SkillList>("/skills");
  const actions = useSkillActions(tx, q.refetch);
  const [filter, setFilter] = useState<SkillFilter>("all");
  const [open, setOpen] = useState<string | null>(null);

  const skills = q.data?.skills ?? [];
  const agentConnected = q.data?.agentConnected !== false;
  const shown = filterSkills(skills, filter);
  const openSkill = open ? skills.find((s) => s.key === open) ?? null : null;

  const quick = async (s: Skill, kind: "install" | "turn_on" | "turn_off" | "retry" | "update" | "uninstall") => {
    // Install of a skill with required settings goes through the sheet.
    if (kind === "install" && s.configFields.some((f) => f.required && f.default === undefined)) {
      setOpen(s.key);
      return;
    }
    if (kind === "uninstall" && !window.confirm(`${tx(`Uninstall ${s.name.en}?`, `إزالة ${s.name.ar}؟`)} ${tx(...UNINSTALL_CONFIRM)}`)) return;
    if (kind === "turn_off" && !window.confirm(turnOffConfirmText(s, tx))) return;
    await actions.run(s, { kind });
  };

  return (
    <div style={{ display: "grid", gap: 14, alignContent: "start" }}>
      <div style={{ fontSize: 12.5, color: "var(--ink-2)", maxWidth: 640 }}>
        {tx(
          "Skills give your agent ready-made abilities, like booking appointments or opening support tickets. Install one, adjust its settings, and turn it on or off at any time.",
          "تمنح المهارات وكيلك قدرات جاهزة، مثل حجز المواعيد أو فتح تذاكر الدعم. ثبّت المهارة واضبط إعداداتها وفعّلها أو أوقفها في أي وقت.",
        )}
      </div>

      {q.data && !agentConnected && (
        <div role="status" style={{ fontSize: 12.5, padding: 12, borderRadius: 10, border: "1px solid var(--line-soft)", background: "var(--bg-1)" }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{tx("Not connected to Kewy", "غير متصل بكيوي")}</div>
          {tx(
            "This workspace isn't linked to a Kewy AI agent yet, so skills can't be installed. Connect it from the Kewy control panel first.",
            "لم تُربط مساحة العمل هذه بوكيل كيوي الذكاء بعد، لذا لا يمكن تثبيت المهارات. اربطها أولًا من لوحة تحكم كيوي.",
          )}
        </div>
      )}

      <div role="group" aria-label={tx("Filter skills", "تصفية المهارات")} style={{ display: "flex", gap: 6 }}>
        {FILTERS.map((f) => (
          <button key={f.id} type="button" className={`btn sm ${filter === f.id ? "primary" : "ghost"}`} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
            {tx(f.en, f.ar)}
          </button>
        ))}
      </div>

      {q.error && (
        <div role="alert" style={{ fontSize: 12.5, color: "var(--bad)" }}>
          {q.error}
        </div>
      )}

      {q.loading && !q.data ? (
        <div className="muted" style={{ fontSize: 12 }}>
          {tx("loading…", "جارٍ التحميل…")}
        </div>
      ) : shown.length === 0 && q.data ? (
        <div className="muted" style={{ fontSize: 13, padding: "32px 16px", textAlign: "center", border: "1px dashed var(--line-soft)", borderRadius: 12 }}>
          {filter === "installed" ? tx("No skills installed yet.", "لا توجد مهارات مثبتة بعد.") : tx("No skills to show.", "لا توجد مهارات لعرضها.")}
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12 }}>
          {shown.map((s) => {
            const v = cardView(s, can, agentConnected);
            const Icon = ICONS[SKILL_ICON[s.key]] ?? IconLayers;
            const provider = s.requiredConnector?.provider;
            const titleId = `skill-card-${s.key}`;
            const reasonId = `${titleId}-reason`;
            const reason = v.primaryAction.reason && v.primaryAction.reason !== "no_permission" ? reasonText(v.primaryAction.reason, tx, provider) : null;
            const busy = actions.busy?.startsWith(`${s.key}:`) ?? false;
            const primary = v.primaryAction.kind;
            const by = usedBy(s, tx);
            return (
              <div key={s.key} className="card" aria-labelledby={titleId} style={{ padding: 14, display: "grid", gap: 8, alignContent: "start" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span aria-hidden="true" style={{ display: "grid", placeItems: "center", width: 30, height: 30, borderRadius: 8, background: "var(--bg-2)" }}>
                    <Icon w={16} />
                  </span>
                  <div id={titleId} style={{ fontSize: 13.5, fontWeight: 600, flex: 1, minWidth: 0 }}>
                    {tx(s.name.en, s.name.ar)}
                  </div>
                  <Badge kind={v.statePill.tone}>{statusLabel(s.status, tx, provider)}</Badge>
                </div>
                <div style={{ fontSize: 12.5, color: "var(--ink-2)" }}>{tx(s.description.en, s.description.ar)}</div>
                {v.updateBadge && (
                  <div>
                    <Badge kind="info">{tx("Update available", "يتوفر تحديث")}</Badge>
                  </div>
                )}
                {s.installed && (
                  <div style={{ fontSize: 11.5, color: "var(--ink-3)", display: "grid", gap: 2 }}>
                    {by && <span>{by}</span>}
                    <span>{usageText(s, tx)}</span>
                  </div>
                )}
                {reason && (
                  <div id={reasonId} style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                    {reason}
                  </div>
                )}
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 2 }}>
                  {!v.readOnly && primary && primary !== "settings" && (
                    <button
                      type="button"
                      className="btn sm primary"
                      disabled={v.primaryAction.disabled || busy}
                      aria-describedby={reason ? reasonId : undefined}
                      aria-label={quickActionLabel(primary, s, tx)}
                      onClick={() => void quick(s, primary)}
                    >
                      {actionLabel(primary, tx)}
                    </button>
                  )}
                  {v.secondaryActions
                    .filter((a): a is "update" | "turn_off" => a === "update" || a === "turn_off")
                    .map((a) => (
                      <button key={a} type="button" className="btn sm" disabled={busy} aria-label={quickActionLabel(a, s, tx)} onClick={() => void quick(s, a)}>
                        {actionLabel(a, tx)}
                      </button>
                    ))}
                  <button
                    type="button"
                    className="btn sm ghost"
                    aria-label={quickActionLabel(!v.readOnly && s.installed ? "settings" : "details", s, tx)}
                    onClick={() => setOpen(s.key)}
                  >
                    {v.readOnly ? tx("Details", "التفاصيل") : s.installed ? tx("Settings", "الإعدادات") : tx("Details", "التفاصيل")}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {openSkill && (
        <SkillDetailSheet
          key={`${openSkill.key}:${openSkill.rowVersion}`}
          skill={openSkill}
          tx={tx}
          lang={lang}
          can={can}
          agentConnected={agentConnected}
          actions={actions}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
