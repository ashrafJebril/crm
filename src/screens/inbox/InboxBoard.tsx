import { useState } from "react";
import { Avatar } from "@/components/Avatar";
import type { Contact, Conversation, ConversationLabel, TeamMember } from "@/lib/types";
import type { Tx } from "@/lib/tx";
import {
  BOARD_COLUMNS,
  groupByColumn,
  planBoardMove,
  statusLabels,
  type BoardColumn,
} from "./boardLogic";
import { isLiveThreadId } from "./ConversationActions";
import { EscalateDialog } from "./EscalateDialog";
import { LabelChips } from "./LabelChips";
import { useConversationPatch } from "./useConversationPatch";

/** Kanban over the filtered + sorted list. Native HTML5 drag and drop. */
export function InboxBoard({
  convs,
  contactById,
  teamById,
  labelById,
  onOpen,
  onChanged,
  tx,
}: {
  convs: Conversation[];
  contactById: Map<string, Contact>;
  teamById: Map<string, TeamMember>;
  labelById: Map<string, ConversationLabel>;
  onOpen: (id: string) => void;
  /** Refetch the conversation list(s); awaited before the next action. */
  onChanged: () => Promise<unknown> | void;
  tx: Tx;
}) {
  const { patch, busy, note, escalateError, setEscalateError } = useConversationPatch(tx, onChanged);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<BoardColumn | null>(null);
  const [escalating, setEscalating] = useState<Conversation | null>(null);
  const cols = groupByColumn(convs);
  const sl = statusLabels(tx);
  const title: Record<BoardColumn, string> = {
    human: sl.human,
    pending_customer: sl.pending_customer,
    escalated: tx("Escalated", "مُصعّدة"),
    resolved: sl.resolved,
    closed: sl.closed,
  };
  const liveTip = tx("Available for WhatsApp and synced threads", "متاح لواتساب والمحادثات المتزامنة");

  function drop(col: BoardColumn) {
    const id = dragId;
    setDragId(null);
    setOverCol(null);
    const conv = convs.find((c) => c.id === id);
    if (!conv || isLiveThreadId(conv.id) || busy) return;
    const plan = planBoardMove(conv, col);
    if (plan.kind === "escalate") {
      setEscalateError(null);
      setEscalating(conv);
    } else if (plan.kind === "patch") {
      void patch(conv, plan.body);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0 }}>
      {note && (
        <div role="status" style={{ fontSize: 12, color: "var(--warn)", padding: "8px 16px 0" }}>
          {note}
        </div>
      )}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(5, minmax(220px, 1fr))",
          gap: 12,
          padding: 16,
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          opacity: busy ? 0.7 : 1,
        }}
      >
        {BOARD_COLUMNS.map((col) => (
          <section
            key={col}
            aria-label={title[col]}
            onDragOver={(e) => {
              if (dragId) {
                e.preventDefault();
                setOverCol(col);
              }
            }}
            onDragLeave={() => setOverCol((o) => (o === col ? null : o))}
            onDrop={(e) => {
              e.preventDefault();
              drop(col);
            }}
            style={{
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
              background: "var(--bg-1)",
              border: `1px solid ${overCol === col ? "var(--accent)" : "var(--line-soft)"}`,
              borderRadius: 10,
            }}
          >
            <header style={{ padding: "10px 12px", display: "flex", gap: 8, fontWeight: 700, fontSize: 13 }}>
              <span style={col === "escalated" ? { color: "var(--bad)" } : undefined}>{title[col]}</span>
              <span style={{ color: "var(--ink-3)", fontWeight: 500 }}>{cols[col].length}</span>
            </header>
            <div
              style={{
                overflowY: "auto",
                padding: "0 8px 8px",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              {cols[col].map((c) => {
                const live = isLiveThreadId(c.id);
                const contact = contactById.get(c.contactId);
                const member = c.assigneeId ? teamById.get(c.assigneeId) : undefined;
                return (
                  <article
                    key={c.id}
                    draggable={!live}
                    title={live ? liveTip : undefined}
                    tabIndex={0}
                    onClick={() => onOpen(c.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") onOpen(c.id);
                    }}
                    onDragStart={(e) => {
                      if (live) {
                        e.preventDefault();
                        return;
                      }
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", c.id);
                      setDragId(c.id);
                    }}
                    onDragEnd={() => {
                      setDragId(null);
                      setOverCol(null);
                    }}
                    style={{
                      background: "var(--bg-2)",
                      border: "1px solid var(--line-soft)",
                      borderRadius: 8,
                      padding: 10,
                      cursor: live ? "pointer" : "grab",
                      opacity: dragId === c.id ? 0.5 : 1,
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                    }}
                  >
                    <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <Avatar name={contact?.name} color="200" size="sm" />
                      <span
                        dir="auto"
                        style={{
                          fontWeight: c.unread > 0 ? 700 : 600,
                          fontSize: 13,
                          flex: 1,
                          minWidth: 0,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {contact?.name ?? "—"}
                      </span>
                      {member && <Avatar name={member.name} color={member.color} size="sm" />}
                    </span>
                    <span
                      dir="auto"
                      style={{
                        fontSize: 12,
                        color: "var(--ink-3)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {c.preview}
                    </span>
                    <LabelChips labelIds={c.labelIds ?? []} labelById={labelById} />
                  </article>
                );
              })}
            </div>
          </section>
        ))}
      </div>
      <EscalateDialog
        open={!!escalating}
        busy={busy}
        error={escalateError}
        onClose={() => {
          setEscalating(null);
          setEscalateError(null);
        }}
        onConfirm={async (reason) => {
          if (!escalating) return;
          const res = await patch(escalating, { escalated: true, escalateReason: reason });
          if (res !== "error") setEscalating(null);
        }}
      />
    </div>
  );
}
