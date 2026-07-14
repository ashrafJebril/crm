import { useCallback, useEffect, useState } from "react";
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { StageColumn } from "./StageColumn";
import { MoveStageMenu } from "./MoveStageMenu";
import { TicketCardOverlay } from "./TicketCard";
import { stageColor } from "./stageColors";
import { useMoveTicket } from "./hooks/useTicketMutations";
import { LostReasonModal } from "./LostReasonModal";
import type { Pipeline, Ticket, TicketStage, Lang } from "@/lib/types";

interface PipelineBoardProps {
  pipeline: Pipeline & { stages: TicketStage[] };
  lang: Lang;
  ownerFilter?: string;
  searchQuery: string;
  onCardClick: (ticket: Ticket) => void;
  onOpenConversation: (conversationId: string) => void;
}

export function PipelineBoard({
  pipeline,
  lang,
  ownerFilter,
  searchQuery,
  onCardClick,
  onOpenConversation,
}: PipelineBoardProps) {
  const [activeTicket, setActiveTicket] = useState<Ticket | null>(null);
  const [moveTarget, setMoveTarget] = useState<{
    ticket: Ticket;
    anchorRect: DOMRect;
  } | null>(null);
  const [pendingLost, setPendingLost] = useState<{
    ticket: Ticket;
    toStage: TicketStage;
  } | null>(null);

  // ── Board-level initial-load gate ────────────────────────────────────
  // Each column reports when its first fetch settles. We hold every column
  // in the skeleton state until ALL of them have reported, so the user sees
  // one synchronized reveal instead of staggered pop-ins.
  const [loadedStages, setLoadedStages] = useState<Set<string>>(
    () => new Set(),
  );
  const boardReady = loadedStages.size >= pipeline.stages.length;

  useEffect(() => {
    // Reset when the pipeline switches so we re-gate on the new set of stages.
    setLoadedStages(new Set());
  }, [pipeline.id]);

  const reportStageLoaded = useCallback((stageId: string) => {
    setLoadedStages((prev) => {
      if (prev.has(stageId)) return prev;
      const next = new Set(prev);
      next.add(stageId);
      return next;
    });
  }, []);

  const move = useMoveTicket();

  // 6px activation distance so a quick click on the card still fires onClick
  // (drawer) instead of starting a drag.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const doMove = (ticket: Ticket, toStage: TicketStage) => {
    if (toStage.id === ticket.stageId) return;
    if (toStage.isTerminal && !toStage.isWon) {
      setPendingLost({ ticket, toStage });
      return;
    }
    move.mutate({
      ticketId: ticket.id,
      fromStageId: ticket.stageId,
      toStageId: toStage.id,
      pipelineId: pipeline.id,
      optimisticTicket: ticket,
    });
  };

  const handleDragStart = (e: DragStartEvent) => {
    const ticket = e.active.data.current?.ticket as Ticket | undefined;
    if (ticket) setActiveTicket(ticket);
  };

  const handleDragEnd = (e: DragEndEvent) => {
    const ticket = activeTicket ?? (e.active.data.current?.ticket as Ticket | undefined);
    setActiveTicket(null);
    if (!ticket) return;
    const overId = e.over?.id as string | undefined;
    if (!overId) return;
    const toStage = pipeline.stages.find((s) => s.id === overId);
    if (!toStage) return;
    // Defer the cache mutation by one frame so dnd-kit can complete its
    // drag-end cleanup BEFORE React unmounts the source card. Without this
    // delay, fast drags can leave dnd-kit holding a stale reference to the
    // unmounted draggable, which freezes the destination card.
    requestAnimationFrame(() => doMove(ticket, toStage));
  };

  const handlePickStage = (ticket: Ticket, toStage: TicketStage) => {
    setMoveTarget(null);
    doMove(ticket, toStage);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      measuring={{ droppable: { strategy: MeasuringStrategy.BeforeDragging } }}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveTicket(null)}
    >
      <div
        style={{
          display: "flex",
          gap: 14,
          padding: "16px 18px",
          overflowX: "auto",
          overflowY: "hidden",
          height: "100%",
          background:
            "radial-gradient(circle at 50% 0%, color-mix(in srgb, var(--bg-1) 95%, var(--bg-2)) 0%, var(--bg-1) 70%)",
          scrollbarColor: "var(--line) transparent",
          scrollbarWidth: "thin",
        }}
      >
        {pipeline.stages.map((stage) => (
          <div key={stage.id} style={{ height: "100%", flex: "0 0 auto" }}>
            <StageColumn
              stage={stage}
              pipelineId={pipeline.id}
              lang={lang}
              ownerFilter={ownerFilter}
              searchQuery={searchQuery}
              boardReady={boardReady}
              onInitialLoaded={reportStageLoaded}
              onCardClick={onCardClick}
              onOpenConversation={onOpenConversation}
              onOpenMoveMenu={(ticket, anchorRect) =>
                setMoveTarget({ ticket, anchorRect })
              }
            />
          </div>
        ))}
      </div>

      <DragOverlay dropAnimation={null}>
        {activeTicket ? (
          <TicketCardOverlay
            ticket={activeTicket}
            lang={lang}
            accent={
              stageColor[
                pipeline.stages.find((s) => s.id === activeTicket.stageId)
                  ?.color ?? "ink"
              ]
            }
          />
        ) : null}
      </DragOverlay>

      {moveTarget ? (
        <MoveStageMenu
          stages={pipeline.stages}
          currentStageId={moveTarget.ticket.stageId}
          lang={lang}
          anchorRect={moveTarget.anchorRect}
          onClose={() => setMoveTarget(null)}
          onPick={(stage) => handlePickStage(moveTarget.ticket, stage)}
        />
      ) : null}

      {pendingLost ? (
        <LostReasonModal
          lang={lang}
          ticket={pendingLost.ticket}
          onCancel={() => setPendingLost(null)}
          onConfirm={(reason) => {
            move.mutate({
              ticketId: pendingLost.ticket.id,
              fromStageId: pendingLost.ticket.stageId,
              toStageId: pendingLost.toStage.id,
              pipelineId: pipeline.id,
              lostReason: reason,
              optimisticTicket: pendingLost.ticket,
            });
            setPendingLost(null);
          }}
        />
      ) : null}
    </DndContext>
  );
}
