import { useState, type CSSProperties } from "react";
import type { Tx } from "@/lib/tx";
import type { CustomFieldDef, CustomFieldType, Lang } from "@/lib/types";
import { api, ApiError } from "@/api/client";
import { useFetch } from "@/api/useFetch";
import { Modal } from "@/components/Modal";
import { IconPlus, IconTrash } from "@/icons";

const TYPES: CustomFieldType[] = ["text", "number", "date", "select", "boolean"];
const INPUT: CSSProperties = {
  height: 32, padding: "0 10px", borderRadius: 8, border: "1px solid var(--line)",
  background: "var(--bg-1)", color: "var(--ink)", fontSize: 13, fontFamily: "inherit", width: "100%",
};

const typeLabel = (tx: Tx, t: CustomFieldType) =>
  ({
    text: tx("Text", "نص"),
    number: tx("Number", "رقم"),
    date: tx("Date", "تاريخ"),
    select: tx("Select", "قائمة"),
    boolean: tx("Yes/No", "نعم/لا"),
  })[t];

const errMsg = (e: unknown, tx: Tx) => (e instanceof ApiError || e instanceof Error ? e.message : tx("Request failed", "فشل الطلب"));

interface Props {
  tx: Tx;
  lang: Lang;
  onChanged: () => void;
}

/** Custom contact fields (owner/admin): list, create, rename, reorder, delete with a value-count preview. */
export function FieldsTab({ tx, lang, onChanged }: Props) {
  const q = useFetch<CustomFieldDef[]>("/custom-fields");
  const defs = [...(q.data ?? [])].filter((d) => !d.archivedAt).sort((a, b) => a.order - b.order);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<CustomFieldDef | null>(null);
  const [deleting, setDeleting] = useState<{ def: CustomFieldDef; valueCount: number | null } | null>(null);

  const refresh = () => {
    void q.refetch();
    onChanged();
  };

  const move = async (i: number, dir: -1 | 1) => {
    const a = defs[i];
    const b = defs[i + dir];
    if (!a || !b || busy) return;
    setBusy(true);
    setError(null);
    try {
      // Swap positions; if two fields share an order value, spread by index instead.
      const aOrder = a.order === b.order ? i + dir : b.order;
      const bOrder = a.order === b.order ? i : a.order;
      await Promise.all([
        api.patch(`/custom-fields/${a.id}`, { order: aOrder }),
        api.patch(`/custom-fields/${b.id}`, { order: bOrder }),
      ]);
      refresh();
    } catch (e) {
      setError(errMsg(e, tx));
    } finally {
      setBusy(false);
    }
  };

  const askDelete = async (def: CustomFieldDef) => {
    setDeleting({ def, valueCount: null });
    try {
      const r = await api.get<{ valueCount: number }>(`/custom-fields/${def.id}/delete-preview`);
      setDeleting({ def, valueCount: r.valueCount });
    } catch (e) {
      setDeleting(null);
      setError(errMsg(e, tx));
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.delete(`/custom-fields/${deleting.def.id}`);
      setDeleting(null);
      refresh();
    } catch (e) {
      setError(errMsg(e, tx));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ padding: "0 24px 24px", display: "grid", gap: 12, maxWidth: 760 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="muted" style={{ fontSize: 12.5, flex: 1 }}>
          {tx("Custom fields appear on every contact and can be used to filter.", "تظهر الحقول المخصصة على كل جهة اتصال ويمكن استخدامها للتصفية.")}
        </span>
        <button type="button" className="btn primary" onClick={() => setCreating(true)}>
          <IconPlus w={13} /> {tx("New field", "حقل جديد")}
        </button>
      </div>
      {(error || q.error) && (
        <div role="alert" style={{ fontSize: 12, color: "var(--bad)" }}>{error ?? q.error}</div>
      )}
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        {defs.length === 0 && !q.loading && (
          <div className="mono muted" style={{ fontSize: 12, padding: 16 }}>
            {tx("No custom fields yet.", "لا حقول مخصصة بعد.")}
          </div>
        )}
        {defs.map((d, i) => (
          <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderBottom: "1px solid var(--line-soft)" }}>
            <div style={{ display: "grid" }}>
              <button type="button" className="btn ghost icon sm" disabled={i === 0 || busy} aria-label={tx("Move up", "تحريك لأعلى")} onClick={() => void move(i, -1)}>▲</button>
              <button type="button" className="btn ghost icon sm" disabled={i === defs.length - 1 || busy} aria-label={tx("Move down", "تحريك لأسفل")} onClick={() => void move(i, 1)}>▼</button>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div dir="auto" style={{ fontSize: 13.5 }}>{lang === "ar" ? d.labelAr || d.label : d.label}</div>
              <div dir="auto" className="muted" style={{ fontSize: 11.5 }}>
                {lang === "ar" ? d.label : d.labelAr}
                {d.type === "select" && d.options?.length ? ` · ${d.options.join(", ")}` : ""}
              </div>
            </div>
            <span className="mono muted" style={{ fontSize: 11 }}>{typeLabel(tx, d.type)}</span>
            <button type="button" className="btn ghost sm" onClick={() => setEditing(d)}>{tx("Edit", "تعديل")}</button>
            <button type="button" className="btn ghost icon sm" aria-label={tx("Delete field", "حذف الحقل")} onClick={() => void askDelete(d)}>
              <IconTrash w={13} />
            </button>
          </div>
        ))}
      </div>

      {(creating || editing) && (
        <FieldForm
          tx={tx}
          def={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={() => { setCreating(false); setEditing(null); refresh(); }}
        />
      )}

      {deleting && (
        <Modal onClose={busy ? () => {} : () => setDeleting(null)} width={400} label="Delete field" panelStyle={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>{tx("Delete this field?", "حذف هذا الحقل؟")}</h3>
          <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5 }}>
            {deleting.valueCount === null ? (
              tx("Checking…", "جارٍ التحقق…")
            ) : (
              <>
                <b dir="auto">{deleting.def.label}</b>{" "}
                {tx(
                  `will be archived. ${deleting.valueCount} contact value(s) will be hidden and the field can no longer be edited or filtered.`,
                  `سيتم أرشفته. ستُخفى ${deleting.valueCount} قيمة لجهات الاتصال ولن يمكن تعديل الحقل أو التصفية به.`,
                )}
              </>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" className="btn ghost" disabled={busy} onClick={() => setDeleting(null)}>{tx("Cancel", "إلغاء")}</button>
            <button type="button" className="btn" style={{ background: "var(--bad)", color: "white", borderColor: "transparent" }}
              disabled={busy || deleting.valueCount === null} onClick={() => void confirmDelete()}>
              <IconTrash w={13} /> {tx("Delete", "حذف")}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function FieldForm({ tx, def, onClose, onSaved }: { tx: Tx; def: CustomFieldDef | null; onClose: () => void; onSaved: () => void }) {
  const [label, setLabel] = useState(def?.label ?? "");
  const [labelAr, setLabelAr] = useState(def?.labelAr ?? "");
  const [type, setType] = useState<CustomFieldType>(def?.type ?? "text");
  const [options, setOptions] = useState((def?.options ?? []).join("\n"));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const opts = options.split("\n").map((s) => s.trim()).filter(Boolean);
  const valid = !!label.trim() && !!labelAr.trim() && (type !== "select" || opts.length > 0);

  const save = async () => {
    if (!valid) return;
    setSaving(true);
    setError(null);
    try {
      if (def) {
        await api.patch(`/custom-fields/${def.id}`, {
          label: label.trim(),
          labelAr: labelAr.trim(),
          ...(def.type === "select" ? { options: opts } : {}),
        });
      } else {
        await api.post("/custom-fields", {
          label: label.trim(),
          labelAr: labelAr.trim(),
          type,
          ...(type === "select" ? { options: opts } : {}),
        });
      }
      onSaved();
    } catch (e) {
      setError(errMsg(e, tx));
      setSaving(false);
    }
  };

  const lbl: CSSProperties = { fontSize: 11, textTransform: "uppercase", color: "var(--ink-3)", display: "grid", gap: 4 };
  return (
    <Modal onClose={saving ? () => {} : onClose} width={420} label={def ? "Edit field" : "New field"} panelStyle={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <h3 style={{ margin: 0, fontSize: 15 }}>{def ? tx("Edit field", "تعديل الحقل") : tx("New field", "حقل جديد")}</h3>
      <label className="mono" style={lbl}>
        {tx("Label (English)", "الاسم (إنجليزي)")}
        <input dir="auto" style={INPUT} value={label} onChange={(e) => setLabel(e.target.value)} autoFocus />
      </label>
      <label className="mono" style={lbl}>
        {tx("Label (Arabic)", "الاسم (عربي)")}
        <input dir="auto" style={INPUT} value={labelAr} onChange={(e) => setLabelAr(e.target.value)} />
      </label>
      <label className="mono" style={lbl}>
        {tx("Type", "النوع")}
        <select style={INPUT} value={type} disabled={!!def} onChange={(e) => setType(e.target.value as CustomFieldType)}>
          {TYPES.map((t) => (
            <option key={t} value={t}>{typeLabel(tx, t)}</option>
          ))}
        </select>
      </label>
      {type === "select" && (
        <label className="mono" style={lbl}>
          {tx("Options (one per line)", "الخيارات (واحد في كل سطر)")}
          <textarea dir="auto" rows={4} style={{ ...INPUT, height: "auto", padding: 8 }} value={options} onChange={(e) => setOptions(e.target.value)} />
        </label>
      )}
      {error && <div role="alert" style={{ fontSize: 12, color: "var(--bad)" }}>{error}</div>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" className="btn ghost" disabled={saving} onClick={onClose}>{tx("Cancel", "إلغاء")}</button>
        <button type="button" className="btn primary" disabled={!valid || saving} onClick={() => void save()}>
          {saving ? tx("Saving…", "جارٍ الحفظ…") : tx("Save", "حفظ")}
        </button>
      </div>
    </Modal>
  );
}
