import { useEffect, useState } from "react";
import { api } from "@/api/client";
import { useFetch } from "@/api/useFetch";
import { ErrorRow, inputStyle } from "@/screens/settings/form";
import type { Tx } from "@/lib/tx";
import { putGuidelines, sourcesPath, type SourceList } from "./knowledgeApi";
import { GUIDELINES_MAX } from "./knowledgeConstants";
import { errorKey, knowledgeErrorText } from "./knowledgeErrors";

/**
 * SP-21 guidelines: free-text instructions the agent always follows (they go
 * into its prompt, unlike the rest of the knowledge, which it searches).
 */
export function GuidelinesEditor({ tx, canEdit, onDirtyChange }: { tx: Tx; canEdit: boolean; onDirtyChange?: (dirty: boolean) => void }) {
  const q = useFetch<SourceList>(sourcesPath("guideline"));
  const source = q.data?.items[0] ?? null;
  const [text, setText] = useState("");
  /** The saved version shown in the box (null until loaded). */
  const [loaded, setLoaded] = useState<{ version: number; body: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saved, setSaved] = useState(false);
  const dirty = loaded !== null && text !== loaded.body;

  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);

  // Load the saved text; a newer version never overwrites unsaved edits.
  useEffect(() => {
    if (q.data === null) return;
    const next = { version: source?.version ?? 0, body: source?.body ?? "" };
    if (loaded && (loaded.version === next.version || text !== loaded.body)) return;
    setText(next.body);
    setLoaded(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const next = await putGuidelines(text, source?.version ?? 0);
      setLoaded({ version: next.version, body: next.body ?? "" });
      setText(next.body ?? "");
      q.setData({ items: [next] });
      setSaved(true);
    } catch (e) {
      if (errorKey(e) === "knowledge.version_conflict") setConflict(true);
      setError(knowledgeErrorText(e, tx));
    } finally {
      setSaving(false);
    }
  }

  /** After a conflict: load the other person's version (the local edits are dropped). */
  async function reload() {
    setError(null);
    try {
      const fresh = await api.get<SourceList>(sourcesPath("guideline"));
      const s = fresh.items[0] ?? null;
      setLoaded({ version: s?.version ?? 0, body: s?.body ?? "" });
      setText(s?.body ?? "");
      setConflict(false);
      q.setData(fresh);
    } catch (e) {
      setError(knowledgeErrorText(e, tx));
    }
  }

  const len = text.trim().length;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 820 }}>
      <div
        style={{ border: "1px solid var(--line-soft)", borderRadius: 10, padding: "10px 14px", fontSize: 13, background: "var(--bg-1)" }}
      >
        {tx(
          "Guidelines are instructions your assistant always follows, in every conversation: tone, what to avoid, when to hand over to a person. Put facts about your business in Content, FAQs or Files instead.",
          "الإرشادات تعليمات يتبعها مساعدك دائمًا في كل محادثة: الأسلوب وما يجب تجنبه ومتى يحوّل المحادثة إلى شخص. ضع المعلومات عن نشاطك في المحتوى أو الأسئلة الشائعة أو الملفات بدلًا من ذلك.",
        )}
      </div>
      <textarea
        dir="auto"
        value={text}
        readOnly={!canEdit}
        aria-label={tx("Guidelines", "الإرشادات")}
        onChange={(e) => {
          setText(e.target.value);
          setSaved(false);
        }}
        style={{ ...inputStyle, height: "auto", minHeight: 220, padding: "10px 12px", resize: "vertical" }}
        placeholder={tx("For example: Always answer in the customer's language. Never promise a discount.", "مثال: أجب دائمًا بلغة العميل. لا تعِد بأي خصم.")}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="mono" style={{ fontSize: 11, color: len > GUIDELINES_MAX ? "var(--bad)" : "var(--ink-3)" }}>
          <bdi>{`${len}/${GUIDELINES_MAX}`}</bdi>
        </span>
        <span style={{ flex: 1 }} />
        {saved && !dirty && <span className="muted" style={{ fontSize: 12 }}>{tx("Saved", "تم الحفظ")}</span>}
        {canEdit && (
          <>
            {conflict ? (
              <button type="button" className="btn" onClick={reload}>
                {tx("Reload", "إعادة التحميل")}
              </button>
            ) : (
              <button type="button" className="btn ghost" onClick={() => setText(loaded?.body ?? "")} disabled={!dirty || saving}>
                {tx("Discard", "تجاهل التغييرات")}
              </button>
            )}
            <button type="button" className="btn primary" onClick={save} disabled={!dirty || saving || conflict || len > GUIDELINES_MAX}>
              {saving ? tx("Saving…", "جارٍ الحفظ…") : tx("Save", "حفظ")}
            </button>
          </>
        )}
      </div>
      <ErrorRow message={q.error ? knowledgeErrorText(null, tx, q.error) : null} />
      <ErrorRow message={error} />
    </div>
  );
}
