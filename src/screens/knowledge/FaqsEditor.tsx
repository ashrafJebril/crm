import { useMemo, useState } from "react";
import { useFetch } from "@/api/useFetch";
import { useToast } from "@/components/Toast";
import { ErrorRow, inputStyle } from "@/screens/settings/form";
import type { Tx } from "@/lib/tx";
import type { KnowledgeSource } from "@/lib/types";
import { createFaq, deleteSource, patchFaq, reorderFaqs, sourcesPath, type SourceList } from "./knowledgeApi";
import { FAQ_ANSWER_MAX, FAQ_MAX, FAQ_QUESTION_MAX } from "./knowledgeConstants";
import { knowledgeErrorText } from "./knowledgeErrors";
import { filterFaqs, isDuplicateQuestion, moveBy, moveId, orderChanged, type FaqItem } from "./faqModel";

const toItem = (s: KnowledgeSource): FaqItem => ({ id: s.id, question: s.question ?? s.title, answer: s.body ?? "", order: s.order, version: s.version });

function Counter({ value, max }: { value: number; max: number }) {
  return (
    <span className="mono" style={{ fontSize: 11, color: value > max ? "var(--bad)" : "var(--ink-3)" }}>
      <bdi>{`${value}/${max}`}</bdi>
    </span>
  );
}

const area: React.CSSProperties = { ...inputStyle, height: "auto", minHeight: 64, padding: "8px 12px", resize: "vertical" };

/**
 * SP-21 FAQ editor: add on top, inline edit, drag or keyboard reorder
 * (Alt+↑ / Alt+↓, or the arrow buttons), search, counters. Duplicate
 * questions are flagged before saving (the backend refuses them too).
 */
export function FaqsEditor({ tx, canCreate, canEdit, canDelete }: { tx: Tx; canCreate: boolean; canEdit: boolean; canDelete: boolean }) {
  const { toast } = useToast();
  const q = useFetch<SourceList>(sourcesPath("faq"));
  const faqs = useMemo(() => (q.data?.items ?? []).map(toItem), [q.data]);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<FaqItem | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  const ids = faqs.map((f) => f.id);
  const shown = filterFaqs(faqs, search);
  const searching = search.trim() !== "";
  const dup = isDuplicateQuestion(question, faqs);

  async function add() {
    setBusy(true);
    setError(null);
    try {
      await createFaq(question.trim(), answer.trim());
      setQuestion("");
      setAnswer("");
      await q.refetch();
    } catch (e) {
      setError(knowledgeErrorText(e, tx));
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit() {
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      await patchFaq(editing.id, { question: editing.question.trim(), answer: editing.answer.trim(), version: editing.version });
      setEditing(null);
      await q.refetch();
    } catch (e) {
      setError(knowledgeErrorText(e, tx));
    } finally {
      setBusy(false);
    }
  }

  async function remove(f: FaqItem) {
    if (!window.confirm(tx(`Delete the FAQ "${f.question}"?`, `حذف السؤال "${f.question}"؟`))) return;
    try {
      await deleteSource(f.id);
      await q.refetch();
    } catch (e) {
      toast(knowledgeErrorText(e, tx), "error");
    }
  }

  async function reorder(next: string[]) {
    if (!orderChanged(ids, next)) return;
    // Optimistic: show the new order at once, then save it.
    const byId = new Map((q.data?.items ?? []).map((s) => [s.id, s]));
    q.setData({ items: next.map((id, i) => ({ ...(byId.get(id) as KnowledgeSource), order: i })) });
    try {
      q.setData(await reorderFaqs(next));
    } catch (e) {
      toast(knowledgeErrorText(e, tx), "error");
      await q.refetch();
    }
  }

  const canReorder = canEdit && !searching && faqs.length > 1;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 820 }}>
      {canCreate && (
        <div style={{ border: "1px solid var(--line-soft)", borderRadius: 12, padding: 14, display: "grid", gap: 8, background: "var(--bg-1)" }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{tx("Add a question", "إضافة سؤال")}</div>
          <input
            dir="auto"
            style={inputStyle}
            value={question}
            maxLength={FAQ_QUESTION_MAX + 50}
            placeholder={tx("Question", "السؤال")}
            aria-label={tx("Question", "السؤال")}
            onChange={(e) => setQuestion(e.target.value)}
          />
          <textarea
            dir="auto"
            style={area}
            value={answer}
            placeholder={tx("Answer", "الإجابة")}
            aria-label={tx("Answer", "الإجابة")}
            onChange={(e) => setAnswer(e.target.value)}
          />
          <div style={{ display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
            <span style={{ display: "flex", gap: 12 }}>
              <Counter value={question.trim().length} max={FAQ_QUESTION_MAX} />
              <Counter value={answer.trim().length} max={FAQ_ANSWER_MAX} />
            </span>
            {dup && <span style={{ fontSize: 12, color: "var(--bad)" }}>{tx("This question is already in your FAQs.", "هذا السؤال موجود بالفعل في الأسئلة الشائعة.")}</span>}
            <button
              type="button"
              className="btn primary"
              onClick={add}
              disabled={busy || dup || !question.trim() || !answer.trim() || question.trim().length > FAQ_QUESTION_MAX || answer.trim().length > FAQ_ANSWER_MAX || faqs.length >= FAQ_MAX}
            >
              {tx("Add", "إضافة")}
            </button>
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
        <input
          dir="auto"
          type="search"
          style={{ ...inputStyle, maxWidth: 320 }}
          value={search}
          placeholder={tx("Search FAQs", "ابحث في الأسئلة")}
          aria-label={tx("Search FAQs", "ابحث في الأسئلة")}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="muted" style={{ fontSize: 12 }}>
          <bdi>{`${faqs.length}/${FAQ_MAX}`}</bdi> {tx("questions", "سؤالًا")}
        </span>
      </div>
      {canEdit && searching && faqs.length > 1 && (
        <div className="muted" style={{ fontSize: 12 }}>{tx("Clear the search to reorder.", "امسح البحث لإعادة الترتيب.")}</div>
      )}

      <ErrorRow message={q.error ? knowledgeErrorText(null, tx, q.error) : null} />
      <ErrorRow message={error} />

      {faqs.length === 0 && !q.loading && (
        <div className="muted" style={{ fontSize: 13, padding: "24px 0", textAlign: "center" }}>
          {tx("No FAQs yet.", "لا توجد أسئلة شائعة بعد.")}
        </div>
      )}

      <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
        {shown.map((f) => {
          const at = ids.indexOf(f.id);
          const isEditing = editing?.id === f.id;
          const editDup = isEditing && isDuplicateQuestion(editing.question, faqs, f.id);
          return (
            <li
              key={f.id}
              draggable={canReorder && !isEditing}
              onDragStart={() => setDragId(f.id)}
              onDragOver={(e) => canReorder && dragId && e.preventDefault()}
              onDrop={() => {
                if (dragId && dragId !== f.id) void reorder(moveId(ids, ids.indexOf(dragId), at));
                setDragId(null);
              }}
              onDragEnd={() => setDragId(null)}
              tabIndex={canReorder ? 0 : -1}
              onKeyDown={(e) => {
                if (!canReorder || isEditing || !e.altKey) return;
                if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                  e.preventDefault();
                  void reorder(moveBy(ids, f.id, e.key === "ArrowUp" ? -1 : 1));
                }
              }}
              aria-label={canReorder ? tx("FAQ. Alt and arrow keys move it.", "سؤال. استخدم Alt والأسهم لنقله.") : undefined}
              style={{
                border: "1px solid var(--line-soft)",
                borderRadius: 10,
                padding: 12,
                background: dragId === f.id ? "var(--bg-2)" : "var(--bg-1)",
                display: "flex",
                gap: 10,
                alignItems: "flex-start",
              }}
            >
              {canReorder && (
                <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <button type="button" className="btn ghost sm" aria-label={tx("Move up", "نقل لأعلى")} disabled={at === 0} onClick={() => void reorder(moveBy(ids, f.id, -1))}>
                    ↑
                  </button>
                  <button type="button" className="btn ghost sm" aria-label={tx("Move down", "نقل لأسفل")} disabled={at === ids.length - 1} onClick={() => void reorder(moveBy(ids, f.id, 1))}>
                    ↓
                  </button>
                </span>
              )}
              <div style={{ flex: 1, minWidth: 0, display: "grid", gap: 6 }}>
                {isEditing ? (
                  <>
                    <input dir="auto" style={inputStyle} value={editing.question} aria-label={tx("Question", "السؤال")} onChange={(e) => setEditing({ ...editing, question: e.target.value })} />
                    <textarea dir="auto" style={area} value={editing.answer} aria-label={tx("Answer", "الإجابة")} onChange={(e) => setEditing({ ...editing, answer: e.target.value })} />
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <Counter value={editing.question.trim().length} max={FAQ_QUESTION_MAX} />
                      <Counter value={editing.answer.trim().length} max={FAQ_ANSWER_MAX} />
                      {editDup && <span style={{ fontSize: 12, color: "var(--bad)" }}>{tx("This question is already in your FAQs.", "هذا السؤال موجود بالفعل في الأسئلة الشائعة.")}</span>}
                      <span style={{ flex: 1 }} />
                      <button type="button" className="btn ghost sm" onClick={() => setEditing(null)} disabled={busy}>
                        {tx("Cancel", "إلغاء")}
                      </button>
                      <button
                        type="button"
                        className="btn primary sm"
                        onClick={saveEdit}
                        disabled={busy || editDup || !editing.question.trim() || !editing.answer.trim() || editing.question.trim().length > FAQ_QUESTION_MAX || editing.answer.trim().length > FAQ_ANSWER_MAX}
                      >
                        {tx("Save", "حفظ")}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div dir="auto" style={{ fontWeight: 600, fontSize: 13, textAlign: "start" }}>{f.question}</div>
                    <div dir="auto" className="muted" style={{ fontSize: 13, whiteSpace: "pre-wrap", textAlign: "start" }}>{f.answer}</div>
                  </>
                )}
              </div>
              {!isEditing && (
                <span style={{ display: "flex", gap: 4 }}>
                  {canEdit && (
                    <button type="button" className="btn ghost sm" onClick={() => setEditing(f)}>
                      {tx("Edit", "تعديل")}
                    </button>
                  )}
                  {canDelete && (
                    <button type="button" className="btn ghost sm" onClick={() => void remove(f)}>
                      {tx("Delete", "حذف")}
                    </button>
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
