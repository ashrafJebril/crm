import type { Tx } from "@/lib/tx";
import type { CampaignPreviewV2, CustomFieldDef, VarField, VarMap, VarSlot } from "@/lib/types";
import { INPUT_STYLE, fmtNum } from "./ui";
import { FIELD_SOURCES, VAR_VALUE_MAX, slotKeys, varMapIssue, varMapReasonText } from "./varMap";

type Source = VarSlot["source"];

/**
 * SP-13 variable mapping: per {{n}}, a contact field, a custom field
 * (contacts.view) or a fixed value, with an optional fallback. A recipient
 * with no value and no fallback is skipped; the preview's `missingByKey`
 * says how many, under the fields.
 */
export function VariableMappingField({
  tx,
  value,
  onChange,
  customDefs,
  missingByKey,
}: {
  tx: Tx;
  value: VarMap;
  onChange: (m: VarMap) => void;
  /** null when the role can't read custom fields (no contacts.view): contact fields and fixed values only. */
  customDefs: CustomFieldDef[] | null;
  missingByKey: CampaignPreviewV2["missingByKey"] | null;
}) {
  const slots = slotKeys(value);
  const active = (customDefs ?? []).filter((d) => !d.archivedAt);
  const customKeys = customDefs ? new Set(active.map((d) => d.key)) : null;
  const issue = varMapIssue(value, slots.length, customKeys);
  const set = (slot: string, next: VarSlot) => onChange({ ...value, [slot]: next });

  const changeSource = (slot: string, source: Source) => {
    const cur = value[slot]!;
    const fallback = cur.source === "static" ? undefined : cur.fallback;
    if (source === "static") set(slot, { source: "static", value: "" });
    else if (source === "field") set(slot, { source: "field", key: "name", ...(fallback ? { fallback } : {}) });
    else set(slot, { source: "custom", key: active[0]?.key ?? "", ...(fallback ? { fallback } : {}) });
  };

  if (slots.length === 0) return null;

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ fontSize: 12, color: "var(--ink-2)", fontWeight: 500 }}>{tx("Variables", "المتغيرات")}</div>
      {slots.map((slot) => {
        const s = value[slot]!;
        const bad = issue?.slot === slot;
        return (
          <div key={slot} style={{ display: "grid", gap: 6, padding: 10, borderRadius: 10, border: `1px solid ${bad ? "var(--warn)" : "var(--line-soft)"}`, background: "var(--bg-1)" }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <span className="mono" style={{ fontSize: 12, minWidth: 44 }}>
                <bdi dir="ltr">{`{{${slot}}}`}</bdi>
              </span>
              <select
                aria-label={tx(`Source for {{${slot}}}`, `مصدر {{${slot}}}`)}
                style={{ ...INPUT_STYLE, width: 150 }}
                value={s.source}
                onChange={(e) => changeSource(slot, e.target.value as Source)}
              >
                <option value="field">{tx("Contact field", "حقل جهة الاتصال")}</option>
                {customDefs && (
                  <option value="custom" disabled={active.length === 0}>
                    {tx("Custom field", "حقل مخصص")}
                  </option>
                )}
                {!customDefs && s.source === "custom" && <option value="custom">{tx("Custom field", "حقل مخصص")}</option>}
                <option value="static">{tx("Fixed value", "قيمة ثابتة")}</option>
              </select>
              {s.source === "field" && (
                <select
                  aria-label={tx("Field", "الحقل")}
                  style={{ ...INPUT_STYLE, width: 170 }}
                  value={s.key}
                  onChange={(e) => set(slot, { ...s, key: e.target.value as VarField })}
                >
                  {FIELD_SOURCES.map((f) => (
                    <option key={f.key} value={f.key}>
                      {tx(f.label, f.labelAr)}
                    </option>
                  ))}
                </select>
              )}
              {s.source === "custom" && (
                <select
                  aria-label={tx("Custom field", "حقل مخصص")}
                  style={{ ...INPUT_STYLE, width: 170 }}
                  value={s.key}
                  onChange={(e) => set(slot, { ...s, key: e.target.value })}
                >
                  {!active.some((d) => d.key === s.key) && <option value={s.key}>{s.key || "—"}</option>}
                  {active.map((d) => (
                    <option key={d.key} value={d.key}>
                      {tx(d.label, d.labelAr || d.label)}
                    </option>
                  ))}
                </select>
              )}
              {s.source === "static" ? (
                <input
                  dir="auto"
                  style={{ ...INPUT_STYLE, flex: 1, minWidth: 160 }}
                  value={s.value}
                  maxLength={VAR_VALUE_MAX}
                  onChange={(e) => set(slot, { source: "static", value: e.target.value })}
                  placeholder={tx("Same for everyone, e.g. 20%", "نفس القيمة للجميع، مثل 20%")}
                />
              ) : (
                <input
                  dir="auto"
                  style={{ ...INPUT_STYLE, flex: 1, minWidth: 160 }}
                  value={s.fallback ?? ""}
                  maxLength={VAR_VALUE_MAX}
                  onChange={(e) => set(slot, { ...s, fallback: e.target.value })}
                  placeholder={tx("Fallback when empty (optional)", "بديل عند عدم وجود قيمة (اختياري)")}
                />
              )}
            </div>
            {s.source === "field" && s.key === "name" && (
              <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                {tx(
                  "The name comes from WhatsApp's sending service (Zernio). For people it already knows, it uses the name it has stored, which may differ from the name here.",
                  "يأتي الاسم من خدمة الإرسال في واتساب (Zernio). للأشخاص المعروفين لديها، تستخدم الاسم المحفوظ لديها، وقد يختلف عن الاسم هنا.",
                )}
              </div>
            )}
            {s.source !== "static" && !s.fallback?.trim() && (
              <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                {tx("Without a fallback, people with no value are skipped.", "بدون بديل، يُستبعد من ليس لديهم قيمة.")}
              </div>
            )}
            {bad && issue && (
              <div role="alert" style={{ fontSize: 11.5, color: "var(--warn)" }}>
                {varMapReasonText(issue.reason, issue.slot, tx)}
              </div>
            )}
          </div>
        );
      })}
      {!customDefs && (
        <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
          {tx(
            "Custom fields need permission to view contacts.",
            "تتطلب الحقول المخصصة صلاحية عرض جهات الاتصال.",
          )}
        </div>
      )}
      {(missingByKey ?? []).filter((m) => m.count > 0).map((m) => (
        <div key={`${m.source}.${m.key}`} role="status" style={{ fontSize: 12, color: "var(--warn)" }}>
          {tx(
            `${fmtNum(m.count)} ${m.count === 1 ? "recipient" : "recipients"} will be skipped: no value for ${m.label}`,
            `سيُستبعد ${fmtNum(m.count)} مستلم: لا توجد قيمة لـ ${m.labelAr || m.label}`,
          )}
        </div>
      ))}
    </div>
  );
}
