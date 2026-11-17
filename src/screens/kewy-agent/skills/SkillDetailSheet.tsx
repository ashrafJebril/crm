import { useEffect, useRef, useState } from "react";
import { Modal } from "@/components/Modal";
import { Badge } from "@/components/Badge";
import type { Skill } from "@/lib/types";
import type { Tx } from "@/lib/tx";
import { CONNECTORS_HREF, PROVIDER_NAME } from "./skillCatalog";
import { cardView, reasonText, statusLabel, usageText, usedBy, type CardView, type SecondaryKind, type PrimaryKind } from "./skillView";
import { initialValues, validateConfig, type FormValue } from "./skillConfigForm";
import { FIELD_ERROR_COPY, LEGACY_EDITED_COPY, LEGACY_EDITED_LOCKED_COPY } from "./skillErrors";
import { ConfigFieldsForm } from "./ConfigFieldsForm";
import type { SkillAction, useSkillActions } from "./useSkillActions";

type Can = Parameters<typeof cardView>[1];

export function actionLabel(kind: Exclude<PrimaryKind, null> | SecondaryKind, tx: Tx): string {
  switch (kind) {
    case "install":
      return tx("Install", "تثبيت");
    case "turn_on":
      return tx("Turn on", "تفعيل");
    case "turn_off":
      return tx("Turn off", "إيقاف");
    case "settings":
      return tx("Settings", "الإعدادات");
    case "retry":
      return tx("Try again", "حاول مرة أخرى");
    case "update":
      return tx("Update", "تحديث");
    case "uninstall":
      return tx("Uninstall", "إزالة");
  }
}

export const UNINSTALL_CONFIRM: [string, string] = ["Its settings will be deleted.", "ستُحذف إعداداتها."];

/** The turn-off confirmation (review I1): the agent stops using the skill at once. */
export function turnOffConfirmText(skill: Pick<Skill, "name">, tx: Tx): string {
  return tx(`Turn off ${skill.name.en}? Your agent stops using it right away.`, `إيقاف ${skill.name.ar}؟ سيتوقف وكيلك عن استخدامه فورًا.`);
}

/** A card quick action's accessible name, with the skill's name (review M2). */
export function quickActionLabel(kind: Exclude<PrimaryKind, null> | SecondaryKind | "details", skill: Pick<Skill, "name">, tx: Tx): string {
  const name = tx(skill.name.en, skill.name.ar);
  const verb = kind === "details" ? tx("Details", "التفاصيل") : actionLabel(kind, tx);
  return tx(`${verb}: ${name}`, `${verb}: ${name}`);
}

/**
 * SP-22: one skill in full. Tools in plain words (reads vs makes changes), the
 * connector it needs ("Connect Calendly first"; the link to the connectors
 * screen stays hidden until SP-23 builds it), its settings form, its last
 * error, and the same actions as the card. Viewers see it read-only.
 */
export function SkillDetailSheet({
  skill,
  tx,
  lang,
  can,
  agentConnected,
  actions,
  onClose,
}: {
  skill: Skill;
  tx: Tx;
  lang: "en" | "ar";
  can: Can;
  agentConnected: boolean;
  actions: ReturnType<typeof useSkillActions>;
  onClose: () => void;
}) {
  const view: CardView = cardView(skill, can, agentConnected);
  const [values, setValues] = useState<Record<string, FormValue>>(() => initialValues(skill.configFields, skill.config));
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({});
  // Review M3: after a version conflict the list reloads; reset the form from
  // the reloaded row (someone else's change), not the stale edit.
  const seenConflicts = useRef(actions.conflicts);
  useEffect(() => {
    if (actions.conflicts === seenConflicts.current) return;
    seenConflicts.current = actions.conflicts;
    setValues(initialValues(skill.configFields, skill.config));
    setLocalErrors({});
  }, [actions.conflicts, skill.configFields, skill.config]);
  const errors = { ...actions.fieldErrors, ...localErrors };
  const editable = !view.readOnly;
  const provider = skill.requiredConnector?.provider;
  const providerName = provider ? (PROVIDER_NAME[provider] ?? provider) : "";
  const isBusy = actions.busy?.startsWith(`${skill.key}:`) ?? false;
  const titleId = `skill-${skill.key}-title`;

  const validated = (): Record<string, unknown> | null => {
    const r = validateConfig(skill.configFields, values);
    if (r.ok) {
      setLocalErrors({});
      return r.config;
    }
    const out: Record<string, string> = {};
    for (const [k, code] of Object.entries(r.errors)) {
      const copy = FIELD_ERROR_COPY[code] ?? FIELD_ERROR_COPY.wrong_type!;
      out[k] = tx(copy[0], copy[1]);
    }
    setLocalErrors(out);
    return null;
  };

  const act = async (a: SkillAction) => {
    const ok = await actions.run(skill, a);
    if (ok && a.kind === "uninstall") onClose();
  };

  const doPrimaryOrSecondary = async (kind: Exclude<PrimaryKind, null> | SecondaryKind) => {
    switch (kind) {
      case "install": {
        const config = skill.configFields.length ? validated() : undefined;
        if (config === null) return;
        await act({ kind: "install", config });
        return;
      }
      case "settings": {
        const config = validated();
        if (config) await act({ kind: "save", config });
        return;
      }
      case "uninstall":
        if (!window.confirm(`${tx(`Uninstall ${skill.name.en}?`, `إزالة ${skill.name.ar}؟`)} ${tx(...UNINSTALL_CONFIRM)}`)) return;
        await act({ kind: "uninstall" });
        return;
      case "turn_off":
        if (!window.confirm(turnOffConfirmText(skill, tx))) return;
        await act({ kind: "turn_off" });
        return;
      default:
        await act({ kind });
    }
  };

  const reason = reasonText(view.primaryAction.reason, tx, provider);
  const attention = skill.status === "needs_attention";
  const buttons: Array<Exclude<PrimaryKind, null> | SecondaryKind> = [
    ...(view.primaryAction.kind && view.primaryAction.kind !== "settings" ? [view.primaryAction.kind] : []),
    ...view.secondaryActions.filter((a) => a !== "settings"),
  ];
  // "Settings" in the sheet is the form's own Save button.
  const canSave = skill.installed && editable && skill.configFields.length > 0 && skill.attentionReason !== "legacy_edited";

  return (
    <Modal onClose={onClose} width={600} label={tx(skill.name.en, skill.name.ar)}>
      <div dir={lang === "ar" ? "rtl" : "ltr"} style={{ display: "grid", gap: 16 }} aria-labelledby={titleId}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <h2 id={titleId} style={{ fontSize: 16, margin: 0, flex: 1 }}>
            {tx(skill.name.en, skill.name.ar)}
          </h2>
          <Badge kind={view.statePill.tone}>{statusLabel(skill.status, tx, provider)}</Badge>
          {view.updateBadge && <Badge kind="info">{tx("Update available", "يتوفر تحديث")}</Badge>}
        </div>
        <div style={{ fontSize: 13, color: "var(--ink-2)" }}>{tx(skill.description.en, skill.description.ar)}</div>

        <section aria-label={tx("What it can do", "ما الذي يمكنها فعله")} style={{ display: "grid", gap: 6 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600 }}>{tx("What your agent can do with it", "ما يمكن لوكيلك فعله بها")}</div>
          <ul style={{ margin: 0, paddingInlineStart: 18, display: "grid", gap: 4, fontSize: 12.5 }}>
            {skill.tools.map((t) => (
              <li key={t.name}>
                <code dir="ltr">{t.name}</code>{" "}
                <Badge kind={t.kind === "write" ? "warn" : ""}>{t.kind === "write" ? tx("Makes changes", "يُجري تغييرات") : tx("Reads", "يقرأ فقط")}</Badge>
              </li>
            ))}
          </ul>
        </section>

        {view.connectFirst && (
          <div role="note" style={{ fontSize: 12.5, padding: 10, borderRadius: 8, background: "var(--bg-2)" }}>
            {tx(`Connect ${providerName} first. Until then this skill stays off.`, `اربط ${providerName} أولًا. حتى ذلك الحين تبقى هذه المهارة متوقفة.`)}{" "}
            {CONNECTORS_HREF ? (
              <a href={CONNECTORS_HREF}>{tx("Open connectors", "افتح الموصلات")}</a>
            ) : (
              <span className="muted">{tx("Connecting apps is coming soon.", "ربط التطبيقات قادم قريبًا.")}</span>
            )}
          </div>
        )}

        {attention && (
          <div role="alert" style={{ fontSize: 12.5, padding: 10, borderRadius: 8, border: "1px solid var(--bad)" }}>
            {skill.attentionReason === "legacy_edited" ? (
              <>
                {tx(...LEGACY_EDITED_COPY)} {tx(...LEGACY_EDITED_LOCKED_COPY)}
              </>
            ) : (
              <>
                {tx("Applying this skill to your agent failed.", "فشل تطبيق هذه المهارة على وكيلك.")}
                {skill.lastError && (
                  <div dir="auto" className="muted" style={{ marginTop: 4 }}>
                    {skill.lastError}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <div style={{ fontSize: 12, color: "var(--ink-3)", display: "grid", gap: 2 }}>
          <span>{usageText(skill, tx)}</span>
          {usedBy(skill, tx) && <span>{usedBy(skill, tx)}</span>}
          {skill.installedVersion !== null && (
            <span>{tx(`Version ${skill.installedVersion}`, `الإصدار ${skill.installedVersion}`)}{view.updateBadge ? tx(` (${skill.version} available)`, ` (يتوفر ${skill.version})`) : ""}</span>
          )}
        </div>

        {skill.configFields.length > 0 && (
          <section aria-label={tx("Settings", "الإعدادات")} style={{ display: "grid", gap: 10 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600 }}>{tx("Settings", "الإعدادات")}</div>
            <ConfigFieldsForm
              fields={skill.configFields}
              values={values}
              onChange={(k, v) => setValues((prev) => ({ ...prev, [k]: v }))}
              errors={errors}
              tx={tx}
              disabled={!editable || isBusy}
              idPrefix={`skill-${skill.key}`}
            />
            {errors[""] && <div role="alert" style={{ fontSize: 11.5, color: "var(--bad)" }}>{errors[""]}</div>}
            {canSave && (
              <div>
                <button type="button" className="btn" disabled={isBusy} onClick={() => void doPrimaryOrSecondary("settings")}>
                  {tx("Save settings", "حفظ الإعدادات")}
                </button>
              </div>
            )}
          </section>
        )}

        {reason && <div style={{ fontSize: 12, color: "var(--ink-3)" }}>{reason}</div>}

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
          {buttons.map((kind) => (
            <button
              key={kind}
              type="button"
              className={`btn ${kind === buttons[0] && kind !== "uninstall" ? "primary" : kind === "uninstall" ? "ghost" : ""}`.trim()}
              disabled={isBusy || (kind === view.primaryAction.kind && view.primaryAction.disabled)}
              onClick={() => void doPrimaryOrSecondary(kind)}
            >
              {actionLabel(kind, tx)}
            </button>
          ))}
          <button type="button" className="btn ghost" onClick={onClose}>
            {tx("Close", "إغلاق")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
