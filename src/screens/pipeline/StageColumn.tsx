import { useRef, useMemo } from "react";
import { useDroppable } from "@dnd-kit/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useStageTickets } from "./hooks/useStageTickets";
import { TicketCard } from "./TicketCard";
import { stageColor } from "./stageColors";
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
  const accent = stageColor[stage.color] ?? "var(--ink-3)";

  // Aggregate value across visible tickets — useful at-a-glance metric.
  const stageValue = useMemo(
    () =>
      filtered.reduce((sum, t) => sum + (typeof t.value === "number" ? t.value : 0), 0),
    [filtered],
  );

  return (
    <div
      ref={setDroppableRef}
      style={{
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-1)",
        border: `1px solid ${isOver ? accent : "var(--line)"}`,
        boxShadow: isOver
          ? `0 0 0 3px color-mix(in srgb, ${accent} 25%, transparent), 0 4px 16px rgba(0,0,0,0.25)`
          : "0 1px 2px rgba(0,0,0,0.2)",
        borderRadius: 12,
        minWidth: 300,
        maxWidth: 320,
        height: "100%",
        overflow: "hidden",
        transition: "border-color 160ms, box-shadow 160ms",
      }}
    >
      {/* Color accent strip at top */}
      <div style={{ height: 3, background: accent, opacity: 0.9 }} />

      {/* Header */}
      <div
        style={{
          padding: "12px 14px 10px",
          borderBottom: "1px solid var(--line)",
          display: "flex",
          flexDirection: "column",
          gap: 4,
          background: "linear-gradient(180deg, var(--bg-2) 0%, var(--bg-1) 100%)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: 999,
                background: accent,
                boxShadow: `0 0 0 3px color-mix(in srgb, ${accent} 18%, transparent)`,
              }}
            />
            <strong
              style={{
                color: "var(--ink)",
                fontSize: 13,
                letterSpacing: 0.1,
              }}
            >
              {label}
            </strong>
          </div>
          <span
            style={{
              minWidth: 22,
              height: 20,
              padding: "0 7px",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 11,
              fontWeight: 600,
              color: total > 0 ? "var(--ink)" : "var(--ink-3)",
              background: total > 0
                ? `color-mix(in srgb, ${accent} 16%, transparent)`
                : "var(--bg-2)",
              border: `1px solid color-mix(in srgb, ${accent} 30%, var(--line))`,
              borderRadius: 999,
            }}
          >
            {total}
          </span>
        </div>
        {stageValue > 0 ? (
          <div
            className="mono"
            style={{ fontSize: 10, color: "var(--ink-3)", letterSpacing: 0.04 }}
          >
            {stageValue.toLocaleString()} SAR
          </div>
        ) : null}
      </div>

      <div
        ref={parentRef}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: 10,
          scrollbarColor: "var(--line) transparent",
          scrollbarWidth: "thin",
        }}
      >
        {q.isLoading ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                style={{
                  height: 92,
                  background:
                    "linear-gradient(90deg, var(--bg-2) 0%, var(--bg-1) 50%, var(--bg-2) 100%)",
                  backgroundSize: "200% 100%",
                  borderRadius: 10,
                  animation: "shimmer 1.6s ease-in-out infinite",
                  opacity: 0.4,
                }}
              />
            ))}
            <style>{`@keyframes shimmer { 0% { background-position: 200% 0 } 100% { background-position: -200% 0 } }`}</style>
          </div>
        ) : total === 0 ? (
          <div
            style={{
              height: "100%",
              minHeight: 120,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              padding: 16,
              borderRadius: 10,
              border: isOver
                ? `2px dashed ${accent}`
                : "2px dashed transparent",
              transition: "border-color 160ms",
            }}
          >
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: 999,
                background: `color-mix(in srgb, ${accent} 12%, transparent)`,
                display: "grid",
                placeItems: "center",
                color: accent,
                fontSize: 14,
                fontWeight: 600,
              }}
            >
              +
            </div>
            <div
              style={{
                fontSize: 11,
                color: "var(--ink-3)",
                textAlign: "center",
              }}
            >
              {lang === "ar" ? "اسحب التذاكر هنا" : "Drop tickets here"}
            </div>
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
                    accent={accent}
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
              padding: "8px 10px",
              background: "var(--bg-2)",
              border: "1px solid var(--line)",
              borderRadius: 8,
              fontSize: 12,
              color: "var(--ink-2)",
              cursor: "pointer",
              fontWeight: 500,
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
