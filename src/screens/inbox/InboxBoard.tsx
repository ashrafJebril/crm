import { useState, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
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

/** Kanban over the filtered + sorted list. Drag and drop on @dnd-kit, set up like the pipeline board. */
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
  const [escalatingId, setEscalatingId] = useState<string | null>(null);
  const [busyNote, setBusyNote] = useState<string | null>(null);
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
  // Same as the pipeline board: 6px activation so a plain click still opens the thread.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const dragged = convs.find((c) => c.id === dragId) ?? null;
  // Looked up at use time so a refetch since the drop never leaves a stale version.
  const escalating = convs.find((c) => c.id === escalatingId) ?? null;

  function onDragEnd(e: DragEndEvent) {
    const id = String(e.active.id);
    setDragId(null);
    const col = e.over?.id as BoardColumn | undefined;
    if (!col || !BOARD_COLUMNS.includes(col)) return;
    const conv = convs.find((c) => c.id === id);
    if (!conv || isLiveThreadId(conv.id)) return;
    const plan = planBoardMove(conv, col);
    if (plan.kind === "noop") return;
    if (busy) {
      setBusyNote(tx("Still saving — try again in a moment.", "جارٍ الحفظ — حاول مرة أخرى بعد لحظة."));
      return;
    }
    setBusyNote(null);
    // Defer one frame so dnd-kit finishes its cleanup before the card changes column.
    requestAnimationFrame(() => {
      if (plan.kind === "escalate") {
        setEscalateError(null);
        setEscalatingId(conv.id);
      } else {
        void patch(conv, plan.body);
      }
    });
  }

  const shownNote = busyNote ?? note;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      measuring={{ droppable: { strategy: MeasuringStrategy.BeforeDragging } }}
      onDragStart={(e: DragStartEvent) => setDragId(String(e.active.id))}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragId(null)}
    >
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0 }}>
        {shownNote && (
          <div role="status" style={{ fontSize: 12, color: "var(--warn)", padding: "8px 16px 0" }}>
            {shownNote}
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
            <Column key={col} col={col} title={title[col]} count={cols[col].length}>
              {cols[col].map((c) => (
                <Card
                  key={c.id}
                  conv={c}
                  contact={contactById.get(c.contactId)}
                  member={c.assigneeId ? teamById.get(c.assigneeId) : undefined}
                  labelById={labelById}
                  liveTip={liveTip}
                  onOpen={onOpen}
                />
              ))}
            </Column>
          ))}
        </div>
        <DragOverlay dropAnimation={null}>
          {dragged ? (
            <CardBody
              conv={dragged}
              contact={contactById.get(dragged.contactId)}
              member={dragged.assigneeId ? teamById.get(dragged.assigneeId) : undefined}
              labelById={labelById}
            />
          ) : null}
        </DragOverlay>
        <EscalateDialog
          open={!!escalating}
          busy={busy}
          error={escalateError}
          onClose={() => {
            setEscalatingId(null);
            setEscalateError(null);
          }}
          onConfirm={async (reason) => {
            if (!escalating) return;
            const res = await patch(escalating, { escalated: true, escalateReason: reason });
            if (res !== "error") setEscalatingId(null);
          }}
        />
      </div>
    </DndContext>
  );
}

function Column({
  col,
  title,
  count,
  children,
}: {
  col: BoardColumn;
  title: string;
  count: number;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: col });
  return (
    <section
      ref={setNodeRef}
      aria-label={title}
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        background: "var(--bg-1)",
        border: `1px solid ${isOver ? "var(--accent)" : "var(--line-soft)"}`,
        borderRadius: 10,
      }}
    >
      <header style={{ padding: "10px 12px", display: "flex", gap: 8, fontWeight: 700, fontSize: 13 }}>
        <span style={col === "escalated" ? { color: "var(--bad)" } : undefined}>{title}</span>
        <span style={{ color: "var(--ink-3)", fontWeight: 500 }}>{count}</span>
      </header>
      <div style={{ overflowY: "auto", padding: "0 8px 8px", display: "flex", flexDirection: "column", gap: 8 }}>
        {children}
      </div>
    </section>
  );
}

function Card({
  conv,
  contact,
  member,
  labelById,
  liveTip,
  onOpen,
}: {
  conv: Conversation;
  contact?: Contact;
  member?: TeamMember;
  labelById: Map<string, ConversationLabel>;
  liveTip: string;
  onOpen: (id: string) => void;
}) {
  const live = isLiveThreadId(conv.id);
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: conv.id,
    disabled: live,
  });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      title={live ? liveTip : undefined}
      onClick={() => onOpen(conv.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen(conv.id);
      }}
      style={{
        transform: CSS.Translate.toString(transform),
        visibility: isDragging ? "hidden" : "visible",
        touchAction: live ? undefined : "none",
        cursor: live ? "pointer" : isDragging ? "grabbing" : "grab",
      }}
    >
      <CardBody conv={conv} contact={contact} member={member} labelById={labelById} />
    </div>
  );
}

function CardBody({
  conv: c,
  contact,
  member,
  labelById,
}: {
  conv: Conversation;
  contact?: Contact;
  member?: TeamMember;
  labelById: Map<string, ConversationLabel>;
}) {
  return (
    <article
      style={{
        background: "var(--bg-2)",
        border: "1px solid var(--line-soft)",
        borderRadius: 8,
        padding: 10,
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
}
