import { useRef, useState, type ReactNode } from "react";
import { useFetch } from "@/api/useFetch";
import { useAuth } from "@/auth/context";
import { usePermissions, NO_PERMISSION_AR, NO_PERMISSION_EN } from "@/auth/usePermissions";
import { makeTx } from "@/lib/tx";
import type { Conversation, Lang, TeamMember } from "@/lib/types";
import { statusLabels } from "./boardLogic";
import { EscalateDialog } from "./EscalateDialog";
import { LabelPicker } from "./LabelPicker";
import { Popover } from "./Popover";
import { useConversationPatch } from "./useConversationPatch";

type Status = Conversation["status"];

/** Live Facebook ("t_") and Instagram ("ig:") threads are not stored in our DB. */
export function isLiveThreadId(id: string): boolean {
  return id.startsWith("t_") || id.startsWith("ig:");
}

const STATUSES: Status[] = ["human", "pending_customer", "resolved", "closed", "spam"];

const MENU_PANEL = { minWidth: 190, maxHeight: 320, padding: 4 };

/** Thread-header action menu: a Popover with a labelled button trigger. */
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
  return (
    <Popover
      trigger={`${label} ▾`}
      triggerClassName="btn"
      title={title}
      disabled={disabled}
      panelStyle={MENU_PANEL}
    >
      {children}
    </Popover>
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
  const { can } = usePermissions();
  // Loading counts as denied, so nothing flashes enabled.
  const canUpdate = can("conversations.update");
  const live = isLiveThreadId(conv.id);
  const blocked = live || !canUpdate;
  const disabledTip = !canUpdate
    ? tx(NO_PERMISSION_EN, NO_PERMISSION_AR)
    : live
      ? tx("Available for WhatsApp and synced threads", "متاح لواتساب والمحادثات المتزامنة")
      : undefined;
  const teamQ = useFetch<TeamMember[]>(live ? null : "/team");
  const team = teamQ.data ?? [];
  const { patch: patchConv, busy, note, setNote, escalateError, setEscalateError } =
    useConversationPatch(tx, onChanged);
  const [escalateOpen, setEscalateOpen] = useState(false);
  // Confirm re-reads the latest conversation (a 409 refetch swaps the prop).
  const convRef = useRef(conv);
  convRef.current = conv;

  const statusLabel = statusLabels(tx);

  const patch = (body: Record<string, unknown>) => patchConv(conv, body);

  const assignee = team.find((m) => m.id === conv.assigneeId);
  const assignLabel = conv.assigneeId
    ? (assignee?.name ?? tx("Assigned", "مُسندة"))
    : tx("Unassigned", "غير معيّنة");
  const reopen = conv.status === "resolved" || conv.status === "closed";

  return (
    <>
      <Menu label={assignLabel} disabled={blocked || busy} title={disabledTip}>
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
                <span dir="auto">{m.name}</span>
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
      <Menu label={statusLabel[conv.status] ?? conv.status} disabled={blocked || busy} title={disabledTip}>
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
        disabled={blocked}
        disabledReason={disabledTip}
        onChanged={onChanged}
        onError={setNote}
      />
      <span title={disabledTip} style={{ display: "inline-flex" }}>
        <button
          className="btn"
          disabled={blocked || busy}
          onClick={() => void patch({ pinned: !conv.pinned })}
        >
          {conv.pinned ? tx("Unpin", "إلغاء التثبيت") : tx("Pin", "تثبيت")}
        </button>
      </span>
      <span title={disabledTip} style={{ display: "inline-flex" }}>
        <button
          className="btn"
          disabled={blocked || busy}
          style={conv.escalated ? { borderColor: "var(--bad)", color: "var(--bad)" } : undefined}
          onClick={() => (conv.escalated
              ? void patch({ escalated: false })
              : (setEscalateError(null), setEscalateOpen(true)))}
        >
          {conv.escalated ? tx("De-escalate", "إلغاء التصعيد") : tx("Escalate", "تصعيد")}
        </button>
      </span>
      {conv.escalated && conv.escalateReason && (
        <span
          dir="auto"
          title={conv.escalateReason}
          style={{
            fontSize: 12,
            color: "var(--ink-3)",
            alignSelf: "center",
            maxWidth: 180,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {conv.escalateReason}
        </span>
      )}
      <EscalateDialog
        open={escalateOpen}
        busy={busy}
        error={escalateError}
        onClose={() => {
          setEscalateOpen(false);
          setEscalateError(null);
        }}
        onConfirm={async (reason) => {
          const res = await patchConv(convRef.current, { escalated: true, escalateReason: reason });
          if (res === "ok") setEscalateOpen(false);
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
