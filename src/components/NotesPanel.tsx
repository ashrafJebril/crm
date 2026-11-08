import { memo, useMemo, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { useAuth } from "@/auth/context";
import { usePermissions, NO_PERMISSION_AR, NO_PERMISSION_EN } from "@/auth/usePermissions";
import { makeTx, type Tx } from "@/lib/tx";
import { useFetch, useMutation } from "@/api/useFetch";
import { api } from "@/api/client";
import { renderMentionParts } from "@/lib/mentions";
import { IconPlus, IconMore } from "@/icons";
import { Skeleton } from "./Skeleton";
import { MentionInput, useMentionDraft } from "./MentionInput";
import { MentionText } from "./MentionText";
import { useSeenOnView } from "@/lib/useSeenOnView";
import type { Note, NoteWarning, TeamMember } from "@/lib/types";

type NoteWithWarnings = Note & { warnings?: NoteWarning[] };

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

function warningText(tx: Tx, name: string, reason: NoteWarning["reason"]): string {
  return reason === "not_a_member"
    ? tx(
        `${name} isn't in this workspace and wasn't notified`,
        `${name} ليس عضوًا في مساحة العمل ولم يتم إشعاره`,
      )
    : tx(
        `${name} can't open this record and wasn't notified`,
        `${name} لا يملك صلاحية فتح هذا السجل ولم يتم إشعاره`,
      );
}

function SeenBy({ note, team, selfId, tx }: { note: Note; team: Map<string, TeamMember>; selfId?: string; tx: Tx }) {
  const others = (note.seenBy ?? []).filter((s) => s.userId !== note.authorUserId && s.userId !== selfId);
  if (others.length === 0) return null;
  const shown = others.slice(0, 4);
  const names = others.map((s) => team.get(s.userId)?.name ?? "?").join(", ");
  return (
    <span
      title={`${tx("Seen by", "شوهدت بواسطة")} ${names}`}
      style={{ display: "inline-flex", alignItems: "center", gap: 3 }}
    >
      <span>{tx("Seen by", "شوهدت بواسطة")}</span>
      <span
        dir="auto"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          overflow: "hidden",
          clip: "rect(0 0 0 0)",
          whiteSpace: "nowrap",
        }}
      >
        {names}
      </span>
      {shown.map((s) => {
        const m = team.get(s.userId);
        return (
          <span
            key={s.userId}
            aria-hidden
            style={{
              width: 16,
              height: 16,
              borderRadius: 999,
              background: m?.color || "var(--bg-3)",
              color: "#fff",
              fontSize: 8,
              display: "grid",
              placeItems: "center",
            }}
          >
            {m?.initials ?? "?"}
          </span>
        );
      })}
      {others.length > shown.length && <span>+{others.length - shown.length}</span>}
    </span>
  );
}

function NoteCard({
  note,
  scope,
  team,
  selfId,
  tx,
  isReply,
  onReply,
  onDelete,
  deleting,
}: {
  note: Note;
  scope: Props["scope"];
  team: Map<string, TeamMember>;
  selfId?: string;
  tx: Tx;
  isReply?: boolean;
  onReply?: () => void;
  onDelete?: () => void;
  deleting: boolean;
}) {
  const ref = useSeenOnView(note.id, note.authorUserId === selfId);
  const author = note.authorUserId ? team.get(note.authorUserId)?.name : undefined;
  return (
    <div
      ref={ref}
      style={{
        border: "1px solid var(--line-soft)",
        background: "var(--bg-1)",
        borderRadius: 8,
        padding: "8px 10px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        marginInlineStart: isReply ? 18 : 0,
      }}
    >
      {author && (
        <div dir="auto" style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-2)" }}>
          {author}
        </div>
      )}
      <div style={{ fontSize: 13, lineHeight: 1.4, color: "var(--ink-1)" }}>
        <MentionText body={note.body} />
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 8,
          fontSize: 10,
          color: "var(--ink-3)",
          fontFamily: "var(--font-mono)",
        }}
      >
        <span>{fmt(note.createdAt)}</span>
        {scope === "contact" && note.conversationId && (
          <span title={note.conversationId}>· {tx("from chat", "من المحادثة")}</span>
        )}
        {onReply && (
          <button
            type="button"
            className="btn ghost sm"
            style={{ padding: "0 4px", color: "var(--ink-3)" }}
            onClick={onReply}
          >
            {tx("Reply", "رد")}
          </button>
        )}
        <SeenBy note={note} team={team} selfId={selfId} tx={tx} />
        {onDelete && (
          <button
            type="button"
            className="btn ghost sm"
            style={{ marginInlineStart: "auto", padding: "0 4px", color: "var(--ink-3)" }}
            disabled={deleting}
            onClick={onDelete}
            aria-label={tx("Delete note", "حذف الملاحظة")}
            title={tx("Delete", "حذف")}
          >
            <IconMore w={11} />
          </button>
        )}
      </div>
    </div>
  );
}

function NotesPanelImpl({ contactId, conversationId, scope }: Props) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const { user } = useAuth();
  const selfId = (user as { id?: string } | null)?.id;
  const { can } = usePermissions();
  // Backend: POST /notes = conversations.create; PATCH/DELETE = conversations.update,
  // and only the author may change a note unless the caller has conversations.manage.
  const canAdd = can("conversations.create");
  const canEditAny = can("conversations.manage");
  const canChange = can("conversations.update");

  const listPath =
    scope === "conversation" && conversationId
      ? `/notes?conversationId=${encodeURIComponent(conversationId)}`
      : contactId
        ? `/notes?contactId=${encodeURIComponent(contactId)}`
        : null;

  const listQ = useFetch<Note[]>(listPath);
  const teamQ = useFetch<TeamMember[]>("/team");
  const team = useMemo(() => new Map((teamQ.data ?? []).map((m) => [m.id, m])), [teamQ.data]);

  const createNote = useMutation<
    { contactId: string; conversationId?: string; parentId?: string; body: string },
    NoteWithWarnings
  >((input) => api.post<NoteWithWarnings>("/notes", input));

  const deleteNote = useMutation<{ id: string }, { ok: true }>((input) =>
    api.delete<{ ok: true }>(`/notes/${input.id}`),
  );

  const draft = useMentionDraft();
  const replyDraft = useMentionDraft();
  const [replyTo, setReplyTo] = useState<Note | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  const showWarnings = (body: string, ws: NoteWarning[] | undefined) => {
    if (!ws || ws.length === 0) {
      setWarnings([]);
      return;
    }
    const names = new Map<string, string>();
    for (const p of renderMentionParts(body)) if ("mention" in p) names.set(p.mention.id, p.mention.name);
    setWarnings(
      ws.map((w) => warningText(tx, names.get(w.userId) ?? team.get(w.userId)?.name ?? "—", w.reason)),
    );
  };

  const [submitError, setSubmitError] = useState<string | null>(null);
  const failText = tx("Couldn't save the note. Try again.", "تعذّر حفظ الملاحظة. حاول مرة أخرى.");

  const submit = async () => {
    setSubmitError(null);
    try {
      const body = draft.serialize(teamQ.data ?? []);
      if (!body || !contactId) return;
      const res = await createNote.mutate({
        contactId,
        conversationId: scope === "conversation" ? conversationId : undefined,
        body,
      });
      showWarnings(body, res.warnings);
      draft.reset();
      listQ.refetch();
    } catch {
      setSubmitError(failText);
    }
  };

  const submitReply = async () => {
    setSubmitError(null);
    try {
      const body = replyDraft.serialize(teamQ.data ?? []);
      if (!body || !contactId || !replyTo) return;
      const res = await createNote.mutate({
        contactId,
        conversationId: replyTo.conversationId ?? undefined,
        parentId: replyTo.id,
        body,
      });
      showWarnings(body, res.warnings);
      replyDraft.reset();
      setReplyTo(null);
      listQ.refetch();
    } catch {
      setSubmitError(failText);
    }
  };

  const remove = async (id: string) => {
    await deleteNote.mutate({ id });
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

  const composer = (
    d: typeof draft,
    onSubmit: () => void,
    placeholder: string,
    addLabel: string,
    autoFocus?: boolean,
  ) => (
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
      <MentionInput draft={d} placeholder={placeholder} autoFocus={autoFocus} onSubmit={onSubmit} />
      <button
        className="btn primary sm"
        type="button"
        onClick={onSubmit}
        disabled={!canAdd || createNote.loading || d.text.trim().length === 0}
        title={canAdd ? undefined : tx(NO_PERMISSION_EN, NO_PERMISSION_AR)}
        aria-label={addLabel}
      >
        <IconPlus w={12} />
      </button>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {composer(
        draft,
        submit,
        tx("Add an internal note… (@ to mention)", "أضف ملاحظة داخلية… (@ للإشارة)"),
        tx("Add note", "إضافة ملاحظة"),
      )}
      {(submitError ?? createNote.error) && (
        <div role="alert" style={{ color: "var(--bad)", fontSize: 11 }}>
          {submitError ?? createNote.error}
        </div>
      )}
      {warnings.length > 0 && (
        <div role="status" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {warnings.map((w, i) => (
            <div key={i} dir="auto" style={{ color: "var(--warn)", fontSize: 11 }}>
              {w}
            </div>
          ))}
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
        <div key={n.id} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <NoteCard
            note={n}
            scope={scope}
            team={team}
            selfId={selfId}
            tx={tx}
            onReply={() => {
              replyDraft.reset();
              setReplyTo(replyTo?.id === n.id ? null : n);
            }}
            onDelete={canChange && (canEditAny || n.authorUserId === selfId) ? () => void remove(n.id) : undefined}
            deleting={deleteNote.loading}
          />
          {(n.replies ?? []).map((r) => (
            <NoteCard
              key={r.id}
              note={r}
              scope={scope}
              team={team}
              selfId={selfId}
              tx={tx}
              isReply
              onDelete={canChange && (canEditAny || r.authorUserId === selfId) ? () => void remove(r.id) : undefined}
              deleting={deleteNote.loading}
            />
          ))}
          {replyTo?.id === n.id && (
            <div style={{ marginInlineStart: 18 }}>
              {composer(
                replyDraft,
                submitReply,
                tx("Write a reply…", "اكتب ردًا…"),
                tx("Send reply", "إرسال الرد"),
                true,
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export const NotesPanel = memo(NotesPanelImpl);
