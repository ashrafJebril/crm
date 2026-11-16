import { useCallback, useEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { api } from "@/api/client";
import { useFetch } from "@/api/useFetch";
import { ErrorRow } from "@/screens/settings/form";
import type { Tx } from "@/lib/tx";
import type { KnowledgeSource } from "@/lib/types";
import { putContent, sourcesPath, type SourceList } from "./knowledgeApi";
import { errorKey, knowledgeErrorText } from "./knowledgeErrors";
import { badLinks, knowledgeExtensions, safeLink, sanitizeDoc, upgradePastedLinks } from "./contentDoc";

/**
 * SP-21 "About your business" (R10): TipTap with the allow-listed nodes only
 * (paragraphs, headings 1-3, lists, bold, italic, https/mailto links).
 * Explicit Save and Discard; read-only without knowledge.update; a stale save
 * shows the version-conflict line with a Reload button.
 */
export function ContentEditor({ tx, canEdit, onDirtyChange }: { tx: Tx; canEdit: boolean; onDirtyChange?: (dirty: boolean) => void }) {
  const q = useFetch<SourceList>(sourcesPath("content"));
  const source: KnowledgeSource | null = q.data?.items[0] ?? null;
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saved, setSaved] = useState(false);
  const loadedVersion = useRef<number | null>(null);

  const editor = useEditor({
    // The backend's allow-list exactly (contentDoc.ts; cross-checked in contentDoc.test.ts).
    extensions: knowledgeExtensions(),
    content: "",
    editable: canEdit,
    editorProps: {
      attributes: { dir: "auto", class: "kb-editor", "aria-label": tx("Business content", "محتوى النشاط") },
      // Pasted http links become https (only https and mailto links are kept).
      transformPastedHTML: upgradePastedLinks,
    },
    onUpdate: () => {
      setDirty(true);
      setSaved(false);
    },
  });

  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);

  /** Put a saved version in the editor (no update event, so it is not dirty). */
  const apply = useCallback(
    (s: KnowledgeSource | null) => {
      if (!editor) return;
      editor.commands.setContent((s?.bodyJson as object | null) ?? "", { emitUpdate: false });
      loadedVersion.current = s?.version ?? 0;
      setDirty(false);
      setConflict(false);
    },
    [editor],
  );

  // Load the saved document; a newer version never overwrites unsaved edits.
  useEffect(() => {
    if (!editor || q.data === null) return;
    if (loadedVersion.current === (source?.version ?? 0) || dirty) return;
    apply(source);
  }, [editor, q.data, source, dirty, apply]);

  useEffect(() => {
    editor?.setEditable(canEdit);
  }, [editor, canEdit]);

  // Leaving the page with unsaved edits asks first.
  useEffect(() => {
    if (!dirty) return;
    const onBefore = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBefore);
    return () => window.removeEventListener("beforeunload", onBefore);
  }, [dirty]);

  async function save() {
    if (!editor) return;
    setSaving(true);
    setError(null);
    try {
      const next = await putContent(sanitizeDoc(editor.getJSON()), source?.version ?? 0);
      loadedVersion.current = next.version;
      q.setData({ items: [next] });
      setDirty(false);
      setSaved(true);
    } catch (e) {
      if (errorKey(e) === "knowledge.version_conflict") setConflict(true);
      const links = errorKey(e) === "knowledge.content_invalid" ? badLinks(editor.getJSON()) : [];
      setError(
        links.length
          ? `${knowledgeErrorText(e, tx)} ${tx("Check this link:", "تحقق من هذا الرابط:")} ${links.join(", ")}`
          : knowledgeErrorText(e, tx),
      );
    } finally {
      setSaving(false);
    }
  }

  function discard() {
    apply(source);
    setError(null);
  }

  /** After a conflict: load the other person's version (the local edits are dropped). */
  async function reload() {
    setError(null);
    try {
      const fresh = await api.get<SourceList>(sourcesPath("content"));
      q.setData(fresh);
      apply(fresh.items[0] ?? null);
    } catch (e) {
      setError(knowledgeErrorText(e, tx));
    }
  }

  function setLink() {
    if (!editor) return;
    const current = (editor.getAttributes("link").href as string | undefined) ?? "";
    const input = window.prompt(tx("Link address (https:// or mailto:)", "عنوان الرابط (https:// أو mailto:)"), current);
    if (input === null) return;
    if (!input.trim()) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    const href = safeLink(input);
    if (!href) {
      setError(tx("Use an https:// or mailto: link.", "استخدم رابطًا يبدأ بـ https:// أو mailto:."));
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
  }

  const tool = (label: string, active: boolean, run: () => void, title: string) => (
    <button type="button" className={`btn ghost sm${active ? " active" : ""}`} aria-pressed={active} title={title} onMouseDown={(e) => e.preventDefault()} onClick={run}>
      {label}
    </button>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 820 }}>
      <div className="muted" style={{ fontSize: 13 }}>
        {tx(
          "Describe your business: what you offer, where you are, opening hours and anything customers often ask. Your assistant searches this when it answers.",
          "صف نشاطك: ما تقدمه وموقعك وساعات العمل وكل ما يسأل عنه العملاء كثيرًا. يبحث مساعدك في هذا المحتوى عند الرد.",
        )}
      </div>
      {canEdit && editor && (
        <div role="toolbar" aria-label={tx("Formatting", "التنسيق")} style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {tool("B", editor.isActive("bold"), () => editor.chain().focus().toggleBold().run(), tx("Bold", "عريض"))}
          {tool("I", editor.isActive("italic"), () => editor.chain().focus().toggleItalic().run(), tx("Italic", "مائل"))}
          {([1, 2, 3] as const).map((level) =>
            tool(`H${level}`, editor.isActive("heading", { level }), () => editor.chain().focus().toggleHeading({ level }).run(), tx(`Heading ${level}`, `عنوان ${level}`)),
          )}
          {tool("•", editor.isActive("bulletList"), () => editor.chain().focus().toggleBulletList().run(), tx("Bulleted list", "قائمة نقطية"))}
          {tool("1.", editor.isActive("orderedList"), () => editor.chain().focus().toggleOrderedList().run(), tx("Numbered list", "قائمة مرقمة"))}
          {tool(tx("Link", "رابط"), editor.isActive("link"), setLink, tx("Link", "رابط"))}
        </div>
      )}
      <div
        style={{
          border: "1px solid var(--line)",
          borderRadius: 10,
          background: "var(--bg-1)",
          padding: "8px 14px",
          minHeight: 240,
          textAlign: "start",
          opacity: canEdit ? 1 : 0.9,
        }}
      >
        <EditorContent editor={editor} />
      </div>
      {!canEdit && (
        <div className="muted" style={{ fontSize: 12 }}>
          {tx("You can view this content. Editing needs the knowledge update permission.", "يمكنك عرض هذا المحتوى. يتطلب التعديل صلاحية تحديث المعرفة.")}
        </div>
      )}
      <ErrorRow message={q.error ? knowledgeErrorText(null, tx, q.error) : null} />
      <ErrorRow message={error} />
      {canEdit && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "flex-end" }}>
          {saved && !dirty && <span className="muted" style={{ fontSize: 12 }}>{tx("Saved", "تم الحفظ")}</span>}
          {conflict ? (
            <button type="button" className="btn" onClick={reload}>
              {tx("Reload", "إعادة التحميل")}
            </button>
          ) : (
            <button type="button" className="btn ghost" onClick={discard} disabled={!dirty || saving}>
              {tx("Discard", "تجاهل التغييرات")}
            </button>
          )}
          <button type="button" className="btn primary" onClick={save} disabled={!dirty || saving || conflict}>
            {saving ? tx("Saving…", "جارٍ الحفظ…") : tx("Save", "حفظ")}
          </button>
        </div>
      )}
    </div>
  );
}
