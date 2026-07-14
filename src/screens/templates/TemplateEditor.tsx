import { useState } from "react";
import { api } from "@/api/client";
import { Modal } from "@/components/Modal";
import type { Lang, Template, TemplateButtonDef, TemplateButtonType } from "@/lib/types";

type Category = "TRANSACTIONAL" | "UTILITY" | "MARKETING" | "AUTHENTICATION";
const CATEGORIES: Category[] = ["TRANSACTIONAL", "UTILITY", "MARKETING", "AUTHENTICATION"];

interface Props {
  lang: Lang;
  mode: "create" | "edit";
  // When editing, the template to load values from. When creating, optionally
  // pre-fill (e.g. for duplicate where we want a fresh row pre-populated).
  initial?: Template | null;
  onClose: () => void;
  onSaved: (saved: Template) => void;
}

export function TemplateEditor({ lang, mode, initial, onClose, onSaved }: Props) {
  const ar = lang === "ar";

  const [name, setName] = useState(initial?.name ?? "");
  const [tLang, setTLang] = useState<"en" | "ar">((initial?.lang as "en" | "ar") ?? "en");
  const [category, setCategory] = useState<Category>(
    (initial?.category as Category) ?? "UTILITY",
  );
  const [body, setBody] = useState(initial?.body ?? "");
  const [footer, setFooter] = useState(initial?.footer ?? "");
  const [buttons, setButtons] = useState<TemplateButtonDef[]>(() =>
    parseButtons(initial?.buttons),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addButton = () => {
    if (buttons.length >= 3) return;
    setButtons([...buttons, { type: "QUICK_REPLY", text: "" }]);
  };
  const updateButton = (i: number, patch: Partial<TemplateButtonDef>) => {
    setButtons(buttons.map((b, idx) => (idx === i ? { ...b, ...patch } : b)));
  };
  const removeButton = (i: number) => {
    setButtons(buttons.filter((_, idx) => idx !== i));
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !body.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const payload = {
        name: name.trim(),
        lang: tLang,
        category,
        body: body.trim(),
        footer: footer.trim() || undefined,
        buttons: buttons
          .filter((b) => b.text.trim().length > 0)
          .map((b) => ({
            type: b.type,
            text: b.text.trim(),
            url: b.type === "URL" ? b.url?.trim() : undefined,
            phone_number:
              b.type === "PHONE_NUMBER" ? b.phone_number?.trim() : undefined,
          })),
      };
      const saved =
        mode === "create"
          ? await api.post<Template>("/templates", payload)
          : await api.patch<Template>(`/templates/${initial!.id}`, payload);
      onSaved(saved);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal onClose={onClose} width={520} label={mode === "create" ? "New template" : "Edit template"}>
      <form
        onSubmit={onSubmit}
        style={{ display: "flex", flexDirection: "column", gap: 12 }}
      >
        <h3 style={{ margin: 0, fontSize: 15, color: "var(--ink)" }}>
          {mode === "create"
            ? ar
              ? "قالب جديد"
              : "New template"
            : ar
              ? "تعديل القالب"
              : "Edit template"}
        </h3>

        <Field label={ar ? "الاسم" : "Name"}>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
            pattern="[a-z0-9_]+"
            title={ar ? "أحرف صغيرة وأرقام وشرطة سفلية فقط" : "lowercase letters, digits, and underscore only"}
            placeholder="order_confirmation"
            style={inputStyle}
          />
        </Field>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field label={ar ? "اللغة" : "Language"}>
            <select
              value={tLang}
              onChange={(e) => setTLang(e.target.value as "en" | "ar")}
              style={inputStyle}
            >
              <option value="en">English</option>
              <option value="ar">العربية</option>
            </select>
          </Field>
          <Field label={ar ? "الفئة" : "Category"}>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as Category)}
              style={inputStyle}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field
          label={
            (ar ? "النص" : "Body") + (ar ? " — استخدم {{1}} للمتغيرات" : " — use {{1}} for variables")
          }
        >
          <textarea
            rows={5}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            required
            placeholder={
              ar
                ? "مرحبًا {{1}}، طلبك رقم {{2}} في الطريق."
                : "Hi {{1}}, your order {{2}} is on the way."
            }
            style={{ ...inputStyle, resize: "vertical", fontFamily: "var(--font-mono)" }}
          />
        </Field>

        <Field label={ar ? "تذييل (اختياري، 60 حرفًا)" : "Footer (optional, 60 chars)"}>
          <input
            type="text"
            value={footer ?? ""}
            onChange={(e) => setFooter(e.target.value)}
            maxLength={60}
            style={inputStyle}
          />
        </Field>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <label style={{ fontSize: 11, color: "var(--ink-3)" }}>
              {ar ? "أزرار (حتى 3)" : "Buttons (up to 3)"}
            </label>
            <button
              type="button"
              onClick={addButton}
              disabled={buttons.length >= 3}
              style={{
                ...btnSecondary,
                padding: "4px 10px",
                fontSize: 11,
                opacity: buttons.length >= 3 ? 0.5 : 1,
              }}
            >
              + {ar ? "إضافة زر" : "Add button"}
            </button>
          </div>
          {buttons.map((b, i) => (
            <div
              key={i}
              style={{
                display: "grid",
                gridTemplateColumns: "120px 1fr 28px",
                gap: 6,
                alignItems: "center",
              }}
            >
              <select
                value={b.type}
                onChange={(e) =>
                  updateButton(i, { type: e.target.value as TemplateButtonType })
                }
                style={inputStyle}
              >
                <option value="QUICK_REPLY">Quick reply</option>
                <option value="URL">URL</option>
                <option value="PHONE_NUMBER">Phone</option>
              </select>
              <div style={{ display: "grid", gap: 4 }}>
                <input
                  type="text"
                  placeholder={ar ? "نص الزر" : "Button text"}
                  value={b.text}
                  maxLength={25}
                  onChange={(e) => updateButton(i, { text: e.target.value })}
                  style={inputStyle}
                />
                {b.type === "URL" && (
                  <input
                    type="url"
                    placeholder="https://…"
                    value={b.url ?? ""}
                    onChange={(e) => updateButton(i, { url: e.target.value })}
                    style={inputStyle}
                  />
                )}
                {b.type === "PHONE_NUMBER" && (
                  <input
                    type="tel"
                    placeholder="+9715…"
                    value={b.phone_number ?? ""}
                    onChange={(e) => updateButton(i, { phone_number: e.target.value })}
                    style={inputStyle}
                  />
                )}
              </div>
              <button
                type="button"
                onClick={() => removeButton(i)}
                aria-label="Remove"
                style={{
                  ...btnSecondary,
                  padding: 0,
                  width: 28,
                  height: 28,
                  display: "grid",
                  placeItems: "center",
                }}
              >
                ×
              </button>
            </div>
          ))}
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
          style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}
        >
          <button type="button" onClick={onClose} style={btnSecondary}>
            {ar ? "إلغاء" : "Cancel"}
          </button>
          <button type="submit" disabled={submitting} style={btnPrimary}>
            {submitting
              ? ar
                ? "جارٍ الحفظ…"
                : "Saving…"
              : mode === "create"
                ? ar
                  ? "إنشاء"
                  : "Create"
                : ar
                  ? "حفظ"
                  : "Save"}
          </button>
        </div>
      </form>
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

function parseButtons(raw: string | null | undefined): TemplateButtonDef[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (b) => b && typeof b === "object" && typeof b.text === "string",
    );
  } catch {
    return [];
  }
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

const btnSecondary: React.CSSProperties = {
  padding: "8px 14px",
  background: "transparent",
  border: "1px solid var(--line)",
  borderRadius: "var(--r)",
  color: "var(--ink-2)",
  cursor: "pointer",
};

const btnPrimary: React.CSSProperties = {
  padding: "8px 14px",
  background: "var(--accent)",
  border: 0,
  borderRadius: "var(--r)",
  color: "white",
  cursor: "pointer",
};
