import { useRef, useState, type ReactNode } from "react";
import { api, ApiError } from "@/api/client";
import { useFetch } from "@/api/useFetch";
import { useAuth } from "@/auth/context";
import { makeTx } from "@/lib/tx";
import type { Conversation, Lang, TeamMember } from "@/lib/types";
import { EscalateDialog } from "./EscalateDialog";
import { LabelPicker } from "./LabelPicker";

type Status = Conversation["status"];

/** Live Facebook ("t_") and Instagram ("ig:") threads are not stored in our DB. */
export function isLiveThreadId(id: string): boolean {
  return id.startsWith("t_") || id.startsWith("ig:");
}

const STATUSES: Status[] = ["human", "pending_customer", "resolved", "closed", "spam"];

function Menu({
  label,
  disabled,
  title,
  children,
}: {
  label: string;
  disabled?: boolean;
  title?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  return (
    <div style={{ position: "relative" }}>
      <span title={title} style={{ display: "inline-flex" }}>
        <button
          ref={triggerRef}
          className="btn"
          disabled={disabled}
          aria-haspopup="true"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {label} ▾
        </button>
      </span>
      {open && !disabled && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
          <div
            ref={panelRef}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                close();
              } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const items = Array.from(panelRef.current?.querySelectorAll("button") ?? []);
                const i = items.indexOf(document.activeElement as HTMLButtonElement);
                const next = e.key === "ArrowDown" ? i + 1 : i - 1;
                items[(next + items.length) % items.length]?.focus();
              }
            }}
            style={{
              position: "absolute",
              insetInlineEnd: 0,
              top: "calc(100% + 4px)",
              zIndex: 41,
              minWidth: 190,
              maxHeight: 320,
              overflowY: "auto",
              padding: 4,
              background: "var(--bg-1)",
              border: "1px solid var(--line-soft)",
              borderRadius: 8,
              boxShadow: "0 8px 24px rgba(0,0,0,.18)",
            }}
          >
            {children(close)}
          </div>
        </>
      )}
    </div>
  );
}

function Item({
  onClick,
  active,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      className="btn ghost"
      onClick={onClick}
      style={{
        display: "flex",
        width: "100%",
        justifyContent: "flex-start",
        textAlign: "start",
        fontWeight: active ? 700 : 400,
      }}
    >
      {children}
    </button>
  );
}

/**
 * Assign / status / pin / escalate / label controls for the thread header.
 * Every PATCH carries the conversation's `version`; a 409 means someone else
 * changed it first, so we refetch (via onChanged) and tell the user.
 */
export function ConversationActions({
  conv,
  lang,
  onChanged,
}: {
  conv: Conversation;
  lang: Lang;
  /** Refetch the conversation list and the active conversation. */
  onChanged: () => Promise<unknown> | void;
}) {
  const tx = makeTx(lang);
  const { user } = useAuth();
  const live = isLiveThreadId(conv.id);
  const disabledTip = live
    ? tx("Available for WhatsApp and synced threads", "متاح لواتساب والمحادثات المتزامنة")
    : undefined;
  const teamQ = useFetch<TeamMember[]>(live ? null : "/team");
  const team = teamQ.data ?? [];
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [escalateOpen, setEscalateOpen] = useState(false);
  const [escalateError, setEscalateError] = useState<string | null>(null);

  const statusLabel: Record<Status, string> = {
    human: tx("Open", "مفتوحة"),
    pending_customer: tx("Pending customer", "بانتظار العميل"),
    resolved: tx("Resolved", "محلولة"),
    closed: tx("Closed", "مغلقة"),
    spam: tx("Spam", "مزعجة"),
  };

  /** Resolves "ok", "conflict" or "error". busy stays set until the refetch
   *  lands, so the next action always carries the fresh version. */
  async function patch(body: Record<string, unknown>): Promise<"ok" | "conflict" | "error"> {
    if (busy) return "error";
    setBusy(true);
    setNote(null);
    setEscalateError(null);
    try {
      await api.patch(`/conversations/${conv.id}`, { ...body, version: conv.version ?? 0 });
      await onChanged();
      return "ok";
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        await Promise.resolve(onChanged()).catch(() => undefined);
        setNote(
          tx(
            "Someone else just changed this conversation — showing the latest.",
            "قام شخص آخر بتعديل هذه المحادثة للتو — نعرض أحدث نسخة.",
          ),
        );
        return "conflict";
      }
      const msg =
        e instanceof ApiError && e.message
          ? e.message
          : tx("Couldn't update the conversation", "تعذّر تحديث المحادثة");
      setNote(msg);
      setEscalateError(msg);
      return "error";
    } finally {
      setBusy(false);
    }
  }

  const assignee = team.find((m) => m.id === conv.assigneeId);
  const assignLabel = conv.assigneeId
    ? (assignee?.name ?? tx("Assigned", "مُسندة"))
    : tx("Unassigned", "غير مُسندة");
  const reopen = conv.status === "resolved" || conv.status === "closed";

  return (
    <>
      <Menu label={assignLabel} disabled={live || busy} title={disabledTip}>
        {(close) => (
          <>
            {user && (
              <Item
                onClick={() => {
                  close();
                  void patch({ assigneeId: user.id });
                }}
              >
                {tx("Assign to me", "إسناد إليّ")}
              </Item>
            )}
            {team.map((m) => (
              <Item
                key={m.id}
                active={m.id === conv.assigneeId}
                onClick={() => {
                  close();
                  void patch({ assigneeId: m.id });
                }}
              >
                {m.name}
              </Item>
            ))}
            {conv.assigneeId && (
              <Item
                onClick={() => {
                  close();
                  void patch({ assigneeId: null });
                }}
              >
                {tx("Unassign", "إلغاء الإسناد")}
              </Item>
            )}
          </>
        )}
      </Menu>
      <Menu label={statusLabel[conv.status] ?? conv.status} disabled={live || busy} title={disabledTip}>
        {(close) => (
          <>
            {reopen && (
              <Item
                onClick={() => {
                  close();
                  void patch({ status: "human" });
                }}
              >
                {tx("Reopen", "إعادة فتح")}
              </Item>
            )}
            {STATUSES.map((s) => (
              <Item
                key={s}
                active={s === conv.status}
                onClick={() => {
                  close();
                  void patch({ status: s });
                }}
              >
                {statusLabel[s]}
              </Item>
            ))}
          </>
        )}
      </Menu>
      <LabelPicker
        conversationId={conv.id}
        labelIds={conv.labelIds ?? []}
        lang={lang}
        disabled={live}
        disabledReason={disabledTip}
        onChanged={onChanged}
        onError={setNote}
      />
      <span title={disabledTip} style={{ display: "inline-flex" }}>
        <button
          className="btn"
          disabled={live || busy}
          onClick={() => void patch({ pinned: !conv.pinned })}
        >
          {conv.pinned ? tx("Unpin", "إلغاء التثبيت") : tx("Pin", "تثبيت")}
        </button>
      </span>
      <span title={disabledTip} style={{ display: "inline-flex" }}>
        <button
          className="btn"
          disabled={live || busy}
          style={conv.escalated ? { borderColor: "var(--bad)", color: "var(--bad)" } : undefined}
          onClick={() => (conv.escalated ? void patch({ escalated: false }) : setEscalateOpen(true))}
        >
          {conv.escalated ? tx("De-escalate", "إلغاء التصعيد") : tx("Escalate", "تصعيد")}
        </button>
      </span>
      <EscalateDialog
        open={escalateOpen}
        busy={busy}
        error={escalateError}
        onClose={() => {
          setEscalateOpen(false);
          setEscalateError(null);
        }}
        onConfirm={async (reason) => {
          const res = await patch({ escalated: true, escalateReason: reason });
          if (res !== "error") setEscalateOpen(false);
        }}
      />
      {note && (
        <span role="status" style={{ fontSize: 12, color: "var(--warn)", alignSelf: "center" }}>
          {note}
        </span>
      )}
    </>
  );
}
