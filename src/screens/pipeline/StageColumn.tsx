import { useRef, useMemo } from "react";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useStageTickets } from "./hooks/useStageTickets";
import { TicketCard } from "./TicketCard";
import type { Ticket, TicketStage, Lang } from "@/lib/types";

interface StageColumnProps {
  stage: TicketStage;
  pipelineId: string;
  lang: Lang;
  ownerFilter?: string;
  searchQuery: string;
  onCardClick: (ticket: Ticket) => void;
  onOpenConversation: (conversationId: string) => void;
}

function DraggableCard({
  ticket,
  lang,
  onCardClick,
  onOpenConversation,
}: {
  ticket: Ticket;
  lang: Lang;
  onCardClick: (t: Ticket) => void;
  onOpenConversation: (cid: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: ticket.id, data: { ticket } });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <TicketCard
        ticket={ticket}
        lang={lang}
        isDragging={isDragging}
        onClick={() => onCardClick(ticket)}
        onOpenConversation={() =>
          ticket.conversationId && onOpenConversation(ticket.conversationId)
        }
      />
    </div>
  );
}

export function StageColumn({
  stage,
  pipelineId,
  lang,
  ownerFilter,
  searchQuery,
  onCardClick,
  onOpenConversation,
}: StageColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id, data: { stageId: stage.id } });

  const q = useStageTickets(pipelineId, stage.id, {
    ownerId: ownerFilter,
    q: searchQuery,
  });

  const allTickets = useMemo(
    () => q.data?.pages.flatMap((p) => p.items) ?? [],
    [q.data],
  );

  // Client-side search filter (server has no q param)
  const filtered = useMemo(() => {
    if (!searchQuery) return allTickets;
    const needle = searchQuery.toLowerCase();
    return allTickets.filter(
      (t) =>
        t.title.toLowerCase().includes(needle) ||
        t.contact?.name.toLowerCase().includes(needle) ||
        String(t.number).includes(needle),
    );
  }, [allTickets, searchQuery]);

  const parentRef = useRef<HTMLDivElement | null>(null);
  const rowVirtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 120,
    overscan: 6,
  });

  const total = filtered.length;
  const label = lang === "ar" ? stage.labelAr : stage.label;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-1)",
        border: "1px solid var(--line)",
        borderRadius: "var(--r)",
        minWidth: 280,
        maxWidth: 320,
        height: "100%",
      }}
    >
      <div
        style={{
          padding: "10px 12px",
          borderBottom: "1px solid var(--line)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <strong style={{ color: "var(--ink)", fontSize: 13 }}>{label}</strong>
        <span style={{ fontSize: 11, color: "var(--ink-3)", fontFamily: "var(--font-mono)" }}>
          {total}
        </span>
      </div>

      <div
        ref={(node) => {
          setNodeRef(node);
          parentRef.current = node;
        }}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: 8,
          background: isOver ? "var(--bg-hover, rgba(255,255,255,0.04))" : undefined,
          border: isOver ? "2px dashed var(--accent)" : "2px dashed transparent",
          borderRadius: "var(--r)",
          transition: "background 120ms, border 120ms",
        }}
      >
        {q.isLoading ? (
          <div style={{ fontSize: 12, color: "var(--ink-3)", padding: 12 }}>
            {lang === "ar" ? "جارٍ التحميل..." : "Loading..."}
          </div>
        ) : total === 0 ? (
          <div style={{ fontSize: 12, color: "var(--ink-3)", padding: 24, textAlign: "center" }}>
            {lang === "ar" ? "اسحب البطاقات هنا" : "Drop tickets here"}
          </div>
        ) : (
          <SortableContext items={filtered.map((t) => t.id)} strategy={verticalListSortingStrategy}>
            <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
              {rowVirtualizer.getVirtualItems().map((vi) => {
                const ticket = filtered[vi.index];
                return (
                  <div
                    key={ticket.id}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${vi.start}px)`,
                      paddingBottom: 8,
                    }}
                  >
                    <DraggableCard
                      ticket={ticket}
                      lang={lang}
                      onCardClick={onCardClick}
                      onOpenConversation={onOpenConversation}
                    />
                  </div>
                );
              })}
            </div>
          </SortableContext>
        )}

        {q.hasNextPage ? (
          <button
            type="button"
            onClick={() => q.fetchNextPage()}
            disabled={q.isFetchingNextPage}
            style={{
              width: "100%",
              marginTop: 8,
              padding: 8,
              background: "var(--bg-2)",
              border: "1px solid var(--line)",
              borderRadius: "var(--r)",
              fontSize: 12,
              color: "var(--ink-2)",
              cursor: "pointer",
            }}
          >
            {q.isFetchingNextPage
              ? lang === "ar"
                ? "..."
                : "Loading..."
              : lang === "ar"
                ? "تحميل المزيد"
                : "Load more"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
