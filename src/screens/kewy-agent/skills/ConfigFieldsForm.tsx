import { useState } from "react";
import type { SkillConfigField } from "@/lib/types";
import type { Tx } from "@/lib/tx";
import { parseTagsInput, type FormValue } from "./skillConfigForm";

const LABEL: React.CSSProperties = { display: "grid", gap: 4, fontSize: 12.5 };
const HELP: React.CSSProperties = { fontSize: 11.5, color: "var(--ink-3)" };
const ERR: React.CSSProperties = { fontSize: 11.5, color: "var(--bad)" };

/**
 * SP-22: a skill's settings, one input per catalog field (text, textarea,
 * number, select, boolean, tags). Values are kept as FormValue; validation
 * (validateConfig) runs on save, and `errors` shows both client and server
 * messages under each field.
 */
export function ConfigFieldsForm({
  fields,
  values,
  onChange,
  errors,
  tx,
  disabled,
  idPrefix,
}: {
  fields: SkillConfigField[];
  values: Record<string, FormValue>;
  onChange: (key: string, v: FormValue) => void;
  errors: Record<string, string>;
  tx: Tx;
  disabled: boolean;
  idPrefix: string;
}) {
  if (!fields.length) {
    return <div className="muted" style={{ fontSize: 12.5 }}>{tx("This skill has no settings.", "لا توجد إعدادات لهذه المهارة.")}</div>;
  }
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {fields.map((f) => {
        const id = `${idPrefix}-${f.key}`;
        const errId = `${id}-err`;
        const err = errors[f.key];
        const help = tx(f.helpEn ?? "", f.helpAr ?? f.helpEn ?? "");
        const label = (
          <span style={{ fontWeight: 500 }}>
            {tx(f.labelEn, f.labelAr || f.labelEn)}
            {f.required && <span aria-hidden="true" style={{ color: "var(--bad)", marginInlineStart: 4 }}>*</span>}
          </span>
        );
        const common = {
          id,
          disabled,
          "aria-invalid": err ? true : undefined,
          "aria-describedby": err ? errId : undefined,
          "aria-required": f.required || undefined,
        };
        let input: React.ReactNode;
        const v = values[f.key];
        switch (f.type) {
          case "text":
            input = <input {...common} className="input" dir="auto" maxLength={f.maxLength} value={typeof v === "string" ? v : ""} onChange={(e) => onChange(f.key, e.target.value)} />;
            break;
          case "textarea":
            input = (
              <textarea {...common} className="input" dir="auto" rows={4} maxLength={f.maxLength} value={typeof v === "string" ? v : ""} onChange={(e) => onChange(f.key, e.target.value)} />
            );
            break;
          case "number":
            input = (
              <input
                {...common}
                className="input"
                type="number"
                inputMode="numeric"
                dir="ltr"
                min={f.min}
                max={f.max}
                value={typeof v === "number" ? String(v) : ""}
                onChange={(e) => onChange(f.key, e.target.value === "" ? null : Number(e.target.value))}
                style={{ maxWidth: 160 }}
              />
            );
            break;
          case "select":
            input = (
              <select {...common} className="input" value={typeof v === "string" ? v : ""} onChange={(e) => onChange(f.key, e.target.value)} style={{ maxWidth: 260 }}>
                {!f.options?.includes(String(v ?? "")) && <option value="">{tx("Choose…", "اختر…")}</option>}
                {(f.options ?? []).map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            );
            break;
          case "boolean":
            return (
              <div key={f.key} style={{ display: "grid", gap: 4 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
                  <input {...common} type="checkbox" role="switch" checked={v === true} onChange={(e) => onChange(f.key, e.target.checked)} />
                  {label}
                </label>
                {help && <span style={HELP}>{help}</span>}
                {err && <span id={errId} role="alert" style={ERR}>{err}</span>}
              </div>
            );
          case "tags":
            input = <TagsInput common={common} value={Array.isArray(v) ? v : []} onChange={(tags) => onChange(f.key, tags)} tx={tx} />;
            break;
        }
        return (
          <label key={f.key} htmlFor={id} style={LABEL}>
            {label}
            {input}
            {help && <span style={HELP}>{help}</span>}
            {err && <span id={errId} role="alert" style={ERR}>{err}</span>}
          </label>
        );
      })}
    </div>
  );
}

/** Tags as one text box: comma or one per line; parsed on every change. */
function TagsInput({
  common,
  value,
  onChange,
  tx,
}: {
  common: Record<string, unknown>;
  value: string[];
  onChange: (tags: string[]) => void;
  tx: Tx;
}) {
  const [raw, setRaw] = useState(value.join(", "));
  return (
    <>
      <input
        {...common}
        className="input"
        dir="auto"
        value={raw}
        placeholder={tx("vip, wholesale", "vip، جملة")}
        onChange={(e) => {
          setRaw(e.target.value);
          onChange(parseTagsInput(e.target.value));
        }}
      />
      <span style={HELP}>
        {tx(`Separate tags with commas. ${value.length} tag(s).`, `افصل الوسوم بفواصل. عدد الوسوم: ${value.length}.`)}
      </span>
    </>
  );
}
