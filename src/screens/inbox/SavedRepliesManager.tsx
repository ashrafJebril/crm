import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/api/client";
import { useFetch } from "@/api/useFetch";
import { NO_PERMISSION_AR, NO_PERMISSION_EN, usePermissions } from "@/auth/usePermissions";
import type { Tx } from "@/lib/tx";
import { ErrorRow, Field, SettingsCard, inputStyle } from "@/screens/settings/form";
import { SAVED_REPLIES_PATH } from "./SavedRepliesPicker";
import type { SavedReply } from "./thread/threadModel";

const SHORTCUT_RE = /^[a-z0-9_-]{1,32}$/;

interface Draft {
  id: string | null;
  title: string;
  shortcut: string;
  body: string;
  bodyAr: string;
}
const EMPTY: Draft = { id: null, title: "", shortcut: "", body: "", bodyAr: "" };

function errorText(e: unknown, tx: Tx): string {
  if (e instanceof ApiError) {
    if (e.message === "saved_replies.shortcut_exists" || e.code === "saved_replies.shortcut_exists") {
      return tx("This shortcut is already used by another saved reply.", "هذا الاختصار مستخدم في رد محفوظ آخر.");
    }
    if (e.status === 403) return tx(NO_PERMISSION_EN, NO_PERMISSION_AR);
    return e.message;
  }
  return tx("Request failed", "فشل الطلب");
}

/** Settings manager for the workspace's saved replies (conversations.manage). */
export function SavedRepliesManager({ tx }: { tx: Tx }) {
  const { can, loading } = usePermissions();
  const qc = useQueryClient();
  const q = useFetch<SavedReply[]>(SAVED_REPLIES_PATH);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (loading) return null;
  if (!can("conversations.manage")) {
    return (
      <SettingsCard title={tx("Saved replies", "الردود المحفوظة")}>
        <div className="muted" style={{ fontSize: 13 }}>{tx(NO_PERMISSION_EN, NO_PERMISSION_AR)}</div>
      </SettingsCard>
    );
  }

  const replies = q.data ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: [SAVED_REPLIES_PATH] });

  const valid = !!draft && !!draft.title.trim() && SHORTCUT_RE.test(draft.shortcut) && !!draft.body.trim();

  const save = async () => {
    if (!draft || !valid) return;
    setBusy(true);
    setError(null);
    try {
      const payload = {
        title: draft.title.trim(),
        shortcut: draft.shortcut,
        body: draft.body.trim(),
        bodyAr: draft.bodyAr.trim() || undefined,
      };
      if (draft.id) await api.patch(`${SAVED_REPLIES_PATH}/${draft.id}`, payload);
      else await api.post(SAVED_REPLIES_PATH, payload);
      await refresh();
      setDraft(null);
    } catch (e) {
      setError(errorText(e, tx));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (r: SavedReply) => {
    if (!window.confirm(tx(`Delete the saved reply "${r.title}"?`, `حذف الرد المحفوظ "${r.title}"؟`))) return;
    setBusy(true);
    setError(null);
    try {
      await api.delete(`${SAVED_REPLIES_PATH}/${r.id}`);
      await refresh();
    } catch (e) {
      setError(errorText(e, tx));
    } finally {
      setBusy(false);
    }
  };

  const area = { ...inputStyle, height: "auto", minHeight: 84, padding: 10, resize: "vertical" as const };
  const bodyStyle = { display: "block", fontSize: 12, color: "var(--ink-3)", overflowWrap: "anywhere" as const, whiteSpace: "pre-wrap" as const };

  return (
    <SettingsCard
      title={tx("Saved replies", "الردود المحفوظة")}
      description={tx(
        "Canned replies agents insert from the inbox composer. Type / then the shortcut to find one.",
        "ردود جاهزة يدرجها الموظفون من مربع الكتابة في الوارد. اكتب / ثم الاختصار للعثور على رد.",
      )}
      footer={
        !draft && (
          <button type="button" className="btn primary" onClick={() => { setError(null); setDraft({ ...EMPTY }); }}>
            {tx("New saved reply", "رد محفوظ جديد")}
          </button>
        )
      }
    >
      <ErrorRow message={error} />
      {q.error && !q.data && <ErrorRow message={q.error} />}
      {draft && (
        <div style={{ display: "grid", gap: 12, padding: 12, border: "1px solid var(--line)", borderRadius: 10 }}>
          <Field label={tx("Title", "العنوان")}>
            <input
              style={inputStyle}
              dir="auto"
              maxLength={80}
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </Field>
          <Field
            label={tx("Shortcut", "الاختصار")}
            hint={tx(
              "Lowercase letters, digits, - and _ (up to 32). Used as /shortcut.",
              "أحرف إنجليزية صغيرة وأرقام و - و _ (حتى 32). يُستخدم بالشكل /اختصار.",
            )}
          >
            <input
              style={{ ...inputStyle, direction: "ltr" }}
              maxLength={32}
              value={draft.shortcut}
              aria-invalid={draft.shortcut !== "" && !SHORTCUT_RE.test(draft.shortcut)}
              onChange={(e) => setDraft({ ...draft, shortcut: e.target.value.toLowerCase() })}
            />
          </Field>
          <Field label={tx("Reply (English)", "الرد (الإنجليزية)")}>
            <textarea
              style={area}
              dir="auto"
              maxLength={4000}
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            />
          </Field>
          <Field
            label={tx("Reply (Arabic)", "الرد (العربية)")}
            hint={tx(
              "Optional. Agents using the Arabic interface get this one; otherwise the English reply is used.",
              "اختياري. يحصل عليه الموظفون الذين يستخدمون الواجهة العربية، وإلا يُستخدم الرد الإنجليزي.",
            )}
          >
            <textarea
              style={area}
              dir="auto"
              maxLength={4000}
              value={draft.bodyAr}
              onChange={(e) => setDraft({ ...draft, bodyAr: e.target.value })}
            />
          </Field>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" className="btn ghost" disabled={busy} onClick={() => setDraft(null)}>
              {tx("Cancel", "إلغاء")}
            </button>
            <button type="button" className="btn primary" disabled={busy || !valid} onClick={() => void save()}>
              {busy ? tx("Saving…", "جارٍ الحفظ…") : tx("Save", "حفظ")}
            </button>
          </div>
        </div>
      )}
      {q.loading && replies.length === 0 ? (
        <div className="muted" style={{ fontSize: 12 }}>{tx("Loading…", "جارٍ التحميل…")}</div>
      ) : replies.length === 0 ? (
        <div className="muted" style={{ fontSize: 12 }}>{tx("No saved replies yet.", "لا توجد ردود محفوظة بعد.")}</div>
      ) : (
        replies.map((r) => (
          <div
            key={r.id}
            style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "8px 0", borderTop: "1px solid var(--line-soft)" }}
          >
            <span className="mono" style={{ fontSize: 12, color: "var(--accent)", flex: "0 0 auto" }}>/{r.shortcut}</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span dir="auto" style={{ display: "block", fontSize: 13, fontWeight: 600 }}>{r.title}</span>
              <span dir="auto" style={bodyStyle}>{r.body}</span>
              {r.bodyAr && <span dir="auto" style={bodyStyle}>{r.bodyAr}</span>}
            </span>
            <button
              type="button"
              className="btn ghost sm"
              disabled={busy}
              onClick={() => {
                setError(null);
                setDraft({ id: r.id, title: r.title, shortcut: r.shortcut, body: r.body, bodyAr: r.bodyAr ?? "" });
              }}
            >
              {tx("Edit", "تعديل")}
            </button>
            <button type="button" className="btn ghost sm" disabled={busy} onClick={() => void remove(r)}>
              {tx("Delete", "حذف")}
            </button>
          </div>
        ))
      )}
    </SettingsCard>
  );
}
