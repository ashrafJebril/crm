import { useRef, useMemo } from "react";
import { useDroppable } from "@dnd-kit/core";
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
  onOpenMoveMenu: (ticket: Ticket, anchorRect: DOMRect) => void;
}

export function StageColumn({
  stage,
  pipelineId,
  lang,
  ownerFilter,
  searchQuery,
  onCardClick,
  onOpenConversation,
  onOpenMoveMenu,
}: StageColumnProps) {
  const q = useStageTickets(pipelineId, stage.id, { ownerId: ownerFilter });

  const allTickets = useMemo(
    () => q.data?.pages.flatMap((p) => p.items) ?? [],
    [q.data],
  );

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

  // Droppable on the whole column wrapper — stable rect, doesn't shift with
  // virtualizer scroll or content height changes.
  const { setNodeRef: setDroppableRef, isOver } = useDroppable({
    id: stage.id,
    data: { stageId: stage.id },
  });

  const parentRef = useRef<HTMLDivElement | null>(null);
  const rowVirtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 140,
    overscan: 6,
  });

  const total = filtered.length;
  const label = lang === "ar" ? stage.labelAr : stage.label;

  return (
    <div
      ref={setDroppableRef}
      style={{
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-1)",
        border: isOver ? "1px solid var(--accent)" : "1px solid var(--line)",
        boxShadow: isOver
          ? "0 0 0 2px color-mix(in srgb, var(--accent) 40%, transparent)"
          : undefined,
        borderRadius: "var(--r)",
        minWidth: 280,
        maxWidth: 320,
        height: "100%",
        transition: "border-color 120ms, box-shadow 120ms",
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
        <span
          className="mono"
          style={{ fontSize: 11, color: "var(--ink-3)" }}
        >
          {total}
        </span>
      </div>

      <div
        ref={parentRef}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: 8,
        }}
      >
        {q.isLoading ? (
          <div style={{ fontSize: 12, color: "var(--ink-3)", padding: 12 }}>
            {lang === "ar" ? "جارٍ التحميل..." : "Loading..."}
          </div>
        ) : total === 0 ? (
          <div
            style={{
              fontSize: 12,
              color: "var(--ink-3)",
              padding: 24,
              textAlign: "center",
              border: isOver ? "2px dashed var(--accent)" : "2px dashed transparent",
              borderRadius: "var(--r)",
              transition: "border-color 120ms",
            }}
          >
            {lang === "ar" ? "اسحب التذاكر هنا" : "Drop tickets here"}
          </div>
        ) : (
          <div
            style={{
              height: rowVirtualizer.getTotalSize(),
              position: "relative",
            }}
          >
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
                  <TicketCard
                    ticket={ticket}
                    lang={lang}
                    onClick={() => onCardClick(ticket)}
                    onOpenConversation={() =>
                      ticket.conversationId &&
                      onOpenConversation(ticket.conversationId)
                    }
                    onOpenMoveMenu={(rect) => onOpenMoveMenu(ticket, rect)}
                  />
                </div>
              );
            })}
          </div>
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
