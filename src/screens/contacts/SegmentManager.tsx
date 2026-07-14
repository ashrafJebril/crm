import { useEffect, useMemo, useState } from "react";
import { api } from "@/api/client";
import { Modal } from "@/components/Modal";
import type { Contact, Lang, Segment, SegmentFilter } from "@/lib/types";

interface Props {
  lang: Lang;
  contacts: Contact[];
  segments: Segment[];
  onClose: () => void;
  onChanged: () => void;
}

interface DraftState {
  id: string | null;
  name: string;
  nameAr: string;
  color: string;
  filter: SegmentFilter;
}

const EMPTY_DRAFT: DraftState = {
  id: null,
  name: "",
  nameAr: "",
  color: "150",
  filter: {},
};

const HUE_OPTIONS = ["30", "150", "240", "320", "60"];

export function SegmentManager({
  lang,
  contacts,
  segments,
  onClose,
  onChanged,
}: Props) {
  const ar = lang === "ar";
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Distinct facet values derived from the loaded contact list. Not the full
  // truth (contacts list is the visible window, not all rows) but good enough
  // to populate the editor with real options.
  const facets = useMemo(() => {
    const lifecycles = new Set<string>();
    const industries = new Set<string>();
    const sources = new Set<string>();
    const tags = new Set<string>();
    for (const c of contacts) {
      if (c.lifecycle) lifecycles.add(c.lifecycle);
      if (c.industry) industries.add(c.industry);
      if (c.source) sources.add(c.source);
      for (const t of c.tags ?? []) tags.add(t);
    }
    return {
      lifecycles: [...lifecycles].sort(),
      industries: [...industries].sort(),
      sources: [...sources].sort(),
      tags: [...tags].sort(),
    };
  }, [contacts]);

  // Live preview count via /segments/preview — recomputes whenever the draft
  // filter changes. Debounced lightly via the effect dependency.
  useEffect(() => {
    if (Object.keys(draft.filter).length === 0) {
      setPreviewCount(null);
      return;
    }
    let cancelled = false;
    api
      .post<{ count: number }>("/segments/preview", { filter: draft.filter })
      .then((r) => {
        if (!cancelled) setPreviewCount(r.count);
      })
      .catch(() => {
        if (!cancelled) setPreviewCount(null);
      });
    return () => {
      cancelled = true;
    };
  }, [draft.filter]);

  const loadIntoDraft = (s: Segment) => {
    setDraft({
      id: s.id,
      name: s.name,
      nameAr: s.nameAr ?? "",
      color: s.color ?? "150",
      filter: s.filter,
    });
    setError(null);
  };

  const newDraft = () => {
    setDraft(EMPTY_DRAFT);
    setError(null);
  };

  const toggle = (
    key: "lifecycle" | "industry" | "source" | "tagsAny",
    value: string,
  ) => {
    const current = (draft.filter[key] ?? []) as string[];
    const next = current.includes(value)
      ? current.filter((x) => x !== value)
      : [...current, value];
    setDraft({
      ...draft,
      filter: {
        ...draft.filter,
        [key]: next.length > 0 ? next : undefined,
      },
    });
  };

  const setHasPhone = (v: boolean | null) => {
    setDraft({
      ...draft,
      filter: { ...draft.filter, hasPhone: v ?? undefined },
    });
  };

  const setSearch = (v: string) => {
    setDraft({
      ...draft,
      filter: { ...draft.filter, search: v.trim() || undefined },
    });
  };

  const save = async () => {
    if (!draft.name.trim()) {
      setError(ar ? "الاسم مطلوب" : "Name is required");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const payload = {
        name: draft.name.trim(),
        nameAr: draft.nameAr.trim() || undefined,
        color: draft.color || undefined,
        filter: draft.filter,
      };
      if (draft.id) {
        await api.patch(`/segments/${draft.id}`, payload);
      } else {
        await api.post("/segments", payload);
      }
      onChanged();
      newDraft();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      await api.delete(`/segments/${id}`);
      onChanged();
      if (draft.id === id) newDraft();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      onClose={onClose}
      width={820}
      label="Segments"
      panelStyle={{
        padding: 0,
        display: "grid",
        gridTemplateColumns: "220px 1fr",
        overflow: "hidden",
      }}
    >
        {/* segment list */}
        <div
          style={{
            background: "var(--bg-2)",
            borderRight: "1px solid var(--line-soft)",
            display: "flex",
            flexDirection: "column",
            overflowY: "auto",
          }}
        >
          <div
            style={{
              padding: 14,
              borderBottom: "1px solid var(--line-soft)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <h3 style={{ margin: 0, fontSize: 13, color: "var(--ink)" }}>
              {ar ? "الشرائح" : "Segments"}
            </h3>
            <button
              onClick={newDraft}
              className="btn sm"
              style={{ padding: "4px 8px", fontSize: 11 }}
            >
              + {ar ? "جديد" : "New"}
            </button>
          </div>
          {segments.length === 0 && (
            <div
              style={{
                padding: 14,
                fontSize: 12,
                color: "var(--ink-3)",
              }}
            >
              {ar ? "لا توجد شرائح بعد" : "No segments yet"}
            </div>
          )}
          {segments.map((s) => {
            const active = draft.id === s.id;
            return (
              <button
                key={s.id}
                onClick={() => loadIntoDraft(s)}
                style={{
                  textAlign: "start",
                  padding: "10px 14px",
                  background: active ? "var(--accent-soft)" : "transparent",
                  border: 0,
                  borderBottom: "1px solid var(--line-soft)",
                  color: active ? "var(--accent)" : "var(--ink-1)",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 12,
                }}
              >
                <span
                  style={{
                    display: "inline-block",
                    width: 8,
                    height: 8,
                    borderRadius: 999,
                    background: s.color
                      ? `oklch(0.7 0.15 ${s.color})`
                      : "var(--ink-3)",
                  }}
                />
                <span style={{ flex: 1 }}>{ar ? s.nameAr || s.name : s.name}</span>
                <span
                  className="mono"
                  style={{ color: "var(--ink-3)", fontSize: 10 }}
                >
                  {s.count}
                </span>
              </button>
            );
          })}
        </div>

        {/* editor */}
        <div
          style={{
            padding: 18,
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <h3 style={{ margin: 0, fontSize: 14 }}>
              {draft.id
                ? ar
                  ? "تعديل شريحة"
                  : "Edit segment"
                : ar
                  ? "شريحة جديدة"
                  : "New segment"}
            </h3>
            {draft.id && (
              <button
                onClick={() => remove(draft.id!)}
                disabled={busy}
                style={{
                  background: "transparent",
                  border: "1px solid var(--bad)",
                  color: "var(--bad)",
                  borderRadius: "var(--r)",
                  padding: "4px 10px",
                  fontSize: 11,
                  cursor: "pointer",
                }}
              >
                {ar ? "حذف" : "Delete"}
              </button>
            )}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 80px", gap: 8 }}>
            <Field label={ar ? "الاسم" : "Name"}>
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                style={inputStyle}
                placeholder="Hot leads"
              />
            </Field>
            <Field label={ar ? "الاسم بالعربية" : "Name (AR)"}>
              <input
                value={draft.nameAr}
                onChange={(e) => setDraft({ ...draft, nameAr: e.target.value })}
                style={inputStyle}
                placeholder="عملاء محتملون ساخنون"
              />
            </Field>
            <Field label={ar ? "اللون" : "Color"}>
              <select
                value={draft.color}
                onChange={(e) => setDraft({ ...draft, color: e.target.value })}
                style={inputStyle}
              >
                {HUE_OPTIONS.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <FacetGroup
            label={ar ? "دورة الحياة" : "Lifecycle"}
            options={facets.lifecycles}
            selected={draft.filter.lifecycle ?? []}
            onToggle={(v) => toggle("lifecycle", v)}
          />
          <FacetGroup
            label={ar ? "الصناعة" : "Industry"}
            options={facets.industries}
            selected={draft.filter.industry ?? []}
            onToggle={(v) => toggle("industry", v)}
          />
          <FacetGroup
            label={ar ? "المصدر" : "Source"}
            options={facets.sources}
            selected={draft.filter.source ?? []}
            onToggle={(v) => toggle("source", v)}
          />
          <FacetGroup
            label={ar ? "الوسوم (أي)" : "Tags (any)"}
            options={facets.tags}
            selected={draft.filter.tagsAny ?? []}
            onToggle={(v) => toggle("tagsAny", v)}
          />

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <Field label={ar ? "الهاتف" : "Phone"}>
              <select
                value={
                  draft.filter.hasPhone === true
                    ? "yes"
                    : draft.filter.hasPhone === false
                      ? "no"
                      : "any"
                }
                onChange={(e) => {
                  const v = e.target.value;
                  setHasPhone(v === "yes" ? true : v === "no" ? false : null);
                }}
                style={inputStyle}
              >
                <option value="any">{ar ? "أي" : "Any"}</option>
                <option value="yes">{ar ? "موجود" : "Has phone"}</option>
                <option value="no">{ar ? "غير موجود" : "No phone"}</option>
              </select>
            </Field>
            <Field label={ar ? "بحث في الاسم" : "Name contains"}>
              <input
                value={draft.filter.search ?? ""}
                onChange={(e) => setSearch(e.target.value)}
                style={inputStyle}
                placeholder={ar ? "ابحث…" : "search…"}
              />
            </Field>
          </div>

          <div
            style={{
              marginTop: 4,
              padding: "8px 12px",
              borderRadius: "var(--r)",
              background: "var(--bg-2)",
              border: "1px solid var(--line-soft)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              fontSize: 12,
              color: "var(--ink-2)",
            }}
          >
            <span>{ar ? "معاينة" : "Matches"}</span>
            <span className="mono" style={{ color: "var(--accent)" }}>
              {previewCount ?? "—"}
            </span>
          </div>

          {error && (
            <div
              style={{
                padding: "8px 10px",
                background: "color-mix(in oklab, var(--bad) 12%, var(--bg-2))",
                border: "1px solid var(--bad)",
                borderRadius: "var(--r)",
                color: "var(--bad)",
                fontSize: 12,
              }}
            >
              {error}
            </div>
          )}

          <div
            style={{
              display: "flex",
              gap: 8,
              justifyContent: "flex-end",
              marginTop: 4,
            }}
          >
            <button
              onClick={onClose}
              disabled={busy}
              style={{
                padding: "8px 14px",
                background: "transparent",
                border: "1px solid var(--line)",
                borderRadius: "var(--r)",
                color: "var(--ink-2)",
                cursor: "pointer",
              }}
            >
              {ar ? "إغلاق" : "Close"}
            </button>
            <button
              onClick={save}
              disabled={busy}
              style={{
                padding: "8px 14px",
                background: "var(--accent)",
                border: 0,
                borderRadius: "var(--r)",
                color: "white",
                cursor: "pointer",
              }}
            >
              {busy
                ? ar
                  ? "جارٍ الحفظ…"
                  : "Saving…"
                : draft.id
                  ? ar
                    ? "حفظ"
                    : "Save"
                  : ar
                    ? "إنشاء"
                    : "Create"}
            </button>
          </div>
        </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label style={{ fontSize: 11, color: "var(--ink-3)" }}>{label}</label>
      {children}
    </div>
  );
}

function FacetGroup({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: string[];
  selected: string[];
  onToggle: (v: string) => void;
}) {
  if (options.length === 0) return null;
  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {options.map((o) => {
          const on = selected.includes(o);
          return (
            <button
              key={o}
              type="button"
              onClick={() => onToggle(o)}
              style={{
                padding: "4px 10px",
                borderRadius: 999,
                fontSize: 11,
                background: on ? "var(--accent-soft)" : "var(--bg-2)",
                color: on ? "var(--accent)" : "var(--ink-1)",
                border: `1px solid ${on ? "var(--accent-ring)" : "var(--line-soft)"}`,
                cursor: "pointer",
              }}
            >
              {o}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "var(--bg-2)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r)",
  padding: "8px 12px",
  color: "var(--ink)",
  fontSize: 13,
};
