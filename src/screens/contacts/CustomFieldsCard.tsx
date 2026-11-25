import { useId, useState } from "react";
import { api } from "@/api/client";
import { useFetch } from "@/api/useFetch";
import type { Tx } from "@/lib/tx";
import type { ContactFieldValue, Lang } from "@/lib/types";
import { formatFieldValue, parseFieldInput, type FieldValue } from "./fieldValue";
import { CARD, FIELD_INPUT, STATUS_ERROR } from "./drawerStyles";

interface Props {
  tx: Tx;
  lang: Lang;
  contactId: string;
}

/** Inline per-type editors for a contact's custom field values (PUT /contacts/:id/fields). */
export function CustomFieldsCard({ tx, lang, contactId }: Props) {
  const q = useFetch<ContactFieldValue[]>(`/contacts/${contactId}/fields`);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [raw, setRaw] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<{ defId: string; message: string } | null>(null);
  const uid = useId();

  const fields = q.data;
  if (!fields) {
    return (
      <div className="muted" style={{ fontSize: 11 }}>
        {q.error ?? tx("Loading…", "جارٍ التحميل…")}
      </div>
    );
  }
  if (fields.length === 0) {
    return (
      <div className="mono muted" style={{ fontSize: 11, opacity: 0.7 }}>
        {tx("No custom fields defined.", "لا توجد حقول مخصصة.")}
      </div>
    );
  }

  const labelOf = (f: ContactFieldValue): string => (lang === "ar" && f.labelAr ? f.labelAr : f.label);

  const put = async (f: ContactFieldValue, value: FieldValue): Promise<boolean> => {
    setBusyId(f.defId);
    setError(null);
    try {
      const next = await api.put<ContactFieldValue[]>(`/contacts/${contactId}/fields`, {
        values: { [f.defId]: value },
      });
      q.setData(next);
      return true;
    } catch (e) {
      setError({
        defId: f.defId,
        message: e instanceof Error ? e.message : tx("Could not save", "تعذّر الحفظ"),
      });
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const start = (f: ContactFieldValue): void => {
    setError(null);
    setRaw(f.value === null || f.value === undefined ? "" : String(f.value));
    setEditingId(f.defId);
  };

  const commit = async (f: ContactFieldValue): Promise<void> => {
    const parsed = parseFieldInput(f.type, raw, f.options);
    if (!parsed.ok) {
      setError({ defId: f.defId, message: lang === "ar" ? parsed.error.ar : parsed.error.en });
      return;
    }
    if (await put(f, parsed.value)) setEditingId(null);
  };

  return (
    <div style={{ ...CARD, display: "flex", flexDirection: "column", gap: 10 }}>
      {fields.map((f) => {
        const inputId = `${uid}-${f.defId}`;
        const busy = busyId === f.defId;
        const err = error?.defId === f.defId ? error.message : null;
        const label = labelOf(f);

        if (f.type === "boolean") {
          return (
            <div key={f.defId}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
                <input
                  type="checkbox"
                  checked={f.value === true}
                  disabled={busy}
                  onChange={(e) => void put(f, e.target.checked)}
                />
                <span dir="auto">{label}</span>
              </label>
              {err && (
                <div role="alert" style={STATUS_ERROR} dir="auto">
                  {err}
                </div>
              )}
            </div>
          );
        }

        if (editingId !== f.defId) {
          return (
            <div key={f.defId} style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="mono muted" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.06 }} dir="auto">
                  {label}
                </div>
                <div style={{ fontSize: 12.5, overflowWrap: "anywhere" }} dir="auto">
                  {formatFieldValue(f.type, f.value, lang)}
                </div>
              </div>
              <button
                type="button"
                className="btn sm ghost"
                aria-label={`${tx("Edit", "تعديل")} ${label}`}
                onClick={() => start(f)}
              >
                {tx("Edit", "تعديل")}
              </button>
            </div>
          );
        }

        return (
          <form
            key={f.defId}
            onSubmit={(e) => {
              e.preventDefault();
              void commit(f);
            }}
          >
            <label
              htmlFor={inputId}
              className="mono"
              dir="auto"
              style={{ display: "block", fontSize: 10, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: 0.06, marginBottom: 4 }}
            >
              {label}
            </label>
            <div style={{ display: "flex", gap: 6 }}>
              {f.type === "select" ? (
                <select id={inputId} style={FIELD_INPUT} value={raw} onChange={(e) => setRaw(e.target.value)}>
                  <option value="">—</option>
                  {(f.options ?? []).map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={inputId}
                  autoFocus
                  dir={f.type === "text" ? "auto" : "ltr"}
                  inputMode={f.type === "number" ? "decimal" : undefined}
                  placeholder={f.type === "date" ? "YYYY-MM-DD" : undefined}
                  style={{ ...FIELD_INPUT, textAlign: "start" }}
                  value={raw}
                  onChange={(e) => setRaw(e.target.value)}
                />
              )}
              <button type="submit" className="btn sm primary" disabled={busy}>
                {tx("Save", "حفظ")}
              </button>
              <button type="button" className="btn sm ghost" disabled={busy} onClick={() => setEditingId(null)}>
                {tx("Cancel", "إلغاء")}
              </button>
            </div>
            {err && (
              <div role="alert" style={STATUS_ERROR} dir="auto">
                {err}
              </div>
            )}
          </form>
        );
      })}
    </div>
  );
}
