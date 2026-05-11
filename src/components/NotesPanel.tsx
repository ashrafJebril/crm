import { memo, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { useFetch, useMutation } from "@/api/useFetch";
import { api } from "@/api/client";
import { IconPlus, IconMore } from "@/icons";
import { Skeleton } from "./Skeleton";
import type { Note } from "@/lib/types";

interface Props {
  /** Required to create new notes (and to list when scope="contact"). */
  contactId: string | undefined;
  /** When provided, list is filtered to this conversation and new notes are
   *  scoped to it. Pass undefined to list all notes for the contact. */
  conversationId?: string;
  /** "conversation" lists notes for the specific thread; "contact" lists all. */
  scope: "conversation" | "contact";
}

function fmt(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const diffMin = Math.floor((Date.now() - t) / 60000);
  if (diffMin < 1) return "now";
  if (diffMin < 60) return `${diffMin}m`;
  const h = Math.floor(diffMin / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(t).toLocaleDateString();
}

function NotesPanelImpl({ contactId, conversationId, scope }: Props) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);

  const listPath =
    scope === "conversation" && conversationId
      ? `/notes?conversationId=${encodeURIComponent(conversationId)}`
      : contactId
        ? `/notes?contactId=${encodeURIComponent(contactId)}`
        : null;

  const listQ = useFetch<Note[]>(listPath);

  const createNote = useMutation<
    { contactId: string; conversationId?: string; body: string },
    Note
  >((input) => api.post<Note>("/notes", input));

  const deleteNote = useMutation<{ id: string }, { ok: true }>((input) =>
    api.delete<{ ok: true }>(`/notes/${input.id}`),
  );

  const [draft, setDraft] = useState("");
  const submit = async () => {
    const body = draft.trim();
    if (!body || !contactId) return;
    await createNote.mutate({
      contactId,
      conversationId: scope === "conversation" ? conversationId : undefined,
      body,
    });
    setDraft("");
    listQ.refetch();
  };

  if (!contactId) {
    return (
      <div
        className="mono muted"
        style={{ fontSize: 11, padding: 12, opacity: 0.7 }}
      >
        {tx("Notes will appear once this contact is synced.", "ستظهر الملاحظات بعد مزامنة جهة الاتصال.")}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        style={{
          display: "flex",
          gap: 6,
          alignItems: "flex-start",
          padding: 10,
          border: "1px solid var(--line-soft)",
          borderRadius: 8,
          background: "var(--bg)",
        }}
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={tx("Add an internal note…", "أضف ملاحظة داخلية…")}
          rows={2}
          style={{
            flex: 1,
            minHeight: 36,
            resize: "vertical",
            border: 0,
            outline: 0,
            background: "transparent",
            color: "inherit",
            fontSize: 13,
            fontFamily: "inherit",
            lineHeight: 1.4,
          }}
        />
        <button
          className="btn primary sm"
          type="button"
          onClick={submit}
          disabled={createNote.loading || draft.trim().length === 0}
          aria-label={tx("Add note", "إضافة ملاحظة")}
        >
          <IconPlus w={12} />
        </button>
      </div>
      {createNote.error && (
        <div style={{ color: "var(--bad)", fontSize: 11 }}>
          {createNote.error}
        </div>
      )}

      {listQ.loading && !listQ.data && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Skeleton h={28} />
          <Skeleton h={28} />
        </div>
      )}

      {!listQ.loading && (listQ.data ?? []).length === 0 && (
        <div className="mono muted" style={{ fontSize: 11, padding: "4px 2px" }}>
          {tx("No notes yet.", "لا توجد ملاحظات بعد.")}
        </div>
      )}

      {(listQ.data ?? []).map((n) => (
        <div
          key={n.id}
          style={{
            border: "1px solid var(--line-soft)",
            background: "var(--bg-1)",
            borderRadius: 8,
            padding: "8px 10px",
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <div
            style={{
              fontSize: 13,
              lineHeight: 1.4,
              whiteSpace: "pre-wrap",
              color: "var(--ink-1)",
            }}
          >
            {n.body}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 10,
              color: "var(--ink-3)",
              fontFamily: "var(--font-mono)",
            }}
          >
            <span>{fmt(n.createdAt)}</span>
            {scope === "contact" && n.conversationId && (
              <span title={n.conversationId}>
                · {tx("from chat", "من المحادثة")}
              </span>
            )}
            <button
              type="button"
              className="btn ghost sm"
              style={{
                marginInlineStart: "auto",
                padding: "0 4px",
                color: "var(--ink-3)",
              }}
              disabled={deleteNote.loading}
              onClick={async () => {
                await deleteNote.mutate({ id: n.id });
                listQ.refetch();
              }}
              aria-label={tx("Delete note", "حذف الملاحظة")}
              title={tx("Delete", "حذف")}
            >
              <IconMore w={11} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export const NotesPanel = memo(NotesPanelImpl);
