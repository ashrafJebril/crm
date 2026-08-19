import { useState } from "react";
import type { TagRow } from "@/lib/types";
import { useFetch, useMutation } from "@/api/useFetch";
import { api } from "@/api/client";
import { Modal } from "@/components/Modal";
import { IconPlus, IconTrash } from "@/icons";

const HUES = ["0", "30", "60", "90", "120", "150", "180", "210", "240", "270", "300", "330"];

interface TagsTabProps {
  tx: (en: string, ar: string) => string;
  onCatalogChanged: () => void;
}

/** The tag catalog: colored chips with usage counts, inline rename, recolor,
 *  delete-with-impact. Contacts keep tag NAMES; this manages the metadata. */
export function TagsTab({ tx, onCatalogChanged }: TagsTabProps) {
  const tagsQ = useFetch<TagRow[]>("/tags");
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState<string | null>(null); // tag id
  const [editName, setEditName] = useState("");
  const [colorFor, setColorFor] = useState<TagRow | null>(null);
  const [deleting, setDeleting] = useState<TagRow | null>(null);

  const createMut = useMutation<{ name: string }, TagRow>((input) => api.post("/tags", input));
  const updateMut = useMutation<{ id: string; name?: string; color?: string }, { tag: TagRow; contactsUpdated: number }>(
    ({ id, ...body }) => api.patch(`/tags/${id}`, body),
  );
  const deleteMut = useMutation<{ id: string }, { ok: true; contactsUpdated: number }>(({ id }) =>
    api.delete(`/tags/${id}`),
  );

  const refresh = () => {
    tagsQ.refetch();
    onCatalogChanged();
  };
  const rows = tagsQ.data ?? [];

  return (
    <div style={{ padding: "0 24px 24px", display: "grid", gap: 12, maxWidth: 720 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && newName.trim()) {
              void createMut.mutate({ name: newName.trim() }).then(() => {
                setNewName("");
                refresh();
              }).catch(() => {});
            }
          }}
          placeholder={tx("New tag name…", "اسم وسم جديد…")}
          style={{ flex: 1, height: 34, padding: "0 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--bg-1)", color: "var(--ink)", fontSize: 13 }}
        />
        <button
          type="button"
          className="btn primary"
          disabled={!newName.trim() || createMut.loading}
          onClick={() => {
            void createMut.mutate({ name: newName.trim() }).then(() => {
              setNewName("");
              refresh();
            }).catch(() => {});
          }}
        >
          <IconPlus w={13} /> {tx("Add tag", "إضافة وسم")}
        </button>
      </div>
      {(createMut.error || updateMut.error || tagsQ.error) && (
        <div style={{ fontSize: 12, color: "var(--bad)" }}>
          {createMut.error ?? updateMut.error ?? tx("Couldn't load tags.", "تعذر تحميل الوسوم.")}
        </div>
      )}

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        {rows.length === 0 && !tagsQ.loading && (
          <div className="mono muted" style={{ fontSize: 12, padding: 16 }}>
            {tx("No tags yet — create one above.", "لا وسوم بعد — أنشئ واحدًا أعلاه.")}
          </div>
        )}
        {rows.map((t) => (
          <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", borderBottom: "1px solid var(--line-soft)" }}>
            <button
              type="button"
              aria-label={tx("Change color", "تغيير اللون")}
              onClick={() => setColorFor(t)}
              style={{ width: 16, height: 16, borderRadius: "50%", border: "2px solid var(--line-soft)", background: `hsl(${t.color} 70% 45%)`, cursor: "pointer", flexShrink: 0 }}
            />
            {editing === t.id ? (
              <input
                autoFocus
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onBlur={() => setEditing(null)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setEditing(null);
                  if (e.key === "Enter" && editName.trim() && editName.trim() !== t.name) {
                    void updateMut.mutate({ id: t.id, name: editName.trim() }).then(() => {
                      setEditing(null);
                      refresh();
                    }).catch(() => {});
                  }
                }}
                style={{ flex: 1, height: 28, padding: "0 8px", borderRadius: 6, border: "1px solid var(--accent-ring)", background: "var(--bg-1)", color: "var(--ink)", fontSize: 13 }}
              />
            ) : (
              <button
                type="button"
                onClick={() => {
                  setEditing(t.id);
                  setEditName(t.name);
                }}
                title={tx("Click to rename", "انقر لإعادة التسمية")}
                style={{ flex: 1, textAlign: "start", background: "transparent", border: 0, cursor: "text", fontSize: 13.5, color: "var(--ink)", padding: 0 }}
              >
                {t.name}
              </button>
            )}
            <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)", fontVariantNumeric: "tabular-nums" }}>
              {t.usageCount} {tx("contacts", "جهة")}
            </span>
            <button type="button" className="btn ghost icon sm" aria-label={tx("Delete tag", "حذف الوسم")} onClick={() => setDeleting(t)}>
              <IconTrash w={13} />
            </button>
          </div>
        ))}
      </div>

      {colorFor && (
        <Modal onClose={() => setColorFor(null)} width={300} label="Tag color" panelStyle={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <h3 style={{ margin: 0, fontSize: 14 }}>{colorFor.name}</h3>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {HUES.map((h) => (
              <button
                key={h}
                type="button"
                aria-label={`hue ${h}`}
                onClick={() => {
                  void updateMut.mutate({ id: colorFor.id, color: h }).then(() => {
                    setColorFor(null);
                    refresh();
                  }).catch(() => {});
                }}
                style={{ width: 26, height: 26, borderRadius: "50%", cursor: "pointer", background: `hsl(${h} 70% 45%)`, border: colorFor.color === h ? "2px solid var(--ink)" : "2px solid transparent" }}
              />
            ))}
          </div>
        </Modal>
      )}

      {deleting && (
        <Modal onClose={deleteMut.loading ? () => {} : () => setDeleting(null)} width={380} label="Delete tag" panelStyle={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>{tx("Delete this tag?", "حذف هذا الوسم؟")}</h3>
          <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5 }}>
            {tx(
              `"${deleting.name}" will be removed from ${deleting.usageCount} contact(s). This cannot be undone.`,
              `سيُزال "${deleting.name}" من ${deleting.usageCount} جهة اتصال. لا يمكن التراجع.`,
            )}
          </div>
          {deleteMut.error && <div style={{ fontSize: 12, color: "var(--bad)" }}>{deleteMut.error}</div>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" className="btn ghost" onClick={() => setDeleting(null)} disabled={deleteMut.loading}>
              {tx("Cancel", "إلغاء")}
            </button>
            <button
              type="button"
              className="btn"
              style={{ background: "var(--bad)", color: "white", borderColor: "transparent" }}
              disabled={deleteMut.loading}
              onClick={() => {
                void deleteMut.mutate({ id: deleting.id }).then(() => {
                  setDeleting(null);
                  refresh();
                }).catch(() => {});
              }}
            >
              <IconTrash w={13} /> {deleteMut.loading ? tx("Deleting…", "جارٍ الحذف…") : tx("Delete", "حذف")}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
