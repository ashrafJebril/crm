import { useCallback, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  closestCorners,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { StageColumn } from "./StageColumn";
import { TicketCard } from "./TicketCard";
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
  const [pendingLost, setPendingLost] = useState<{
    ticket: Ticket;
    fromStageId: string;
    toStage: TicketStage;
  } | null>(null);

  const move = useMoveTicket();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Custom collision: always prefer the stage column the pointer is inside.
  // Falls back to rectIntersection then closestCorners so edge-overshoots
  // still resolve to *some* column.
  const collisionDetection = useCallback<CollisionDetection>(
    (args) => {
      const stageIds = new Set(pipeline.stages.map((s) => s.id));
      const within = pointerWithin(args);
      const stageHit = within.find((c) => stageIds.has(c.id as string));
      if (stageHit) return [stageHit];
      const intersecting = rectIntersection(args);
      const stageInter = intersecting.find((c) => stageIds.has(c.id as string));
      if (stageInter) return [stageInter];
      return closestCorners(args);
    },
    [pipeline.stages],
  );

  const handleDragStart = (e: DragStartEvent) => {
    const ticket = e.active.data.current?.ticket as Ticket | undefined;
    if (ticket) setActiveTicket(ticket);
  };

  const handleDragEnd = (e: DragEndEvent) => {
    setActiveTicket(null);
    const ticket = e.active.data.current?.ticket as Ticket | undefined;
    if (!ticket) return;

    // `over.id` is either a stage id (when dropped on a column) or a ticket id
    // (when dropped on another card). Resolve target stage from either case.
    const overId = e.over?.id as string | undefined;
    let toStageId: string | null = null;
    if (overId) {
      if (pipeline.stages.some((s) => s.id === overId)) {
        toStageId = overId;
      } else {
        const overTicket = e.over?.data.current?.ticket as Ticket | undefined;
        if (overTicket) toStageId = overTicket.stageId;
      }
    }
    if (!toStageId || toStageId === ticket.stageId) return;
    const toStage = pipeline.stages.find((s) => s.id === toStageId);
    if (!toStage) return;

    if (toStage.isTerminal && !toStage.isWon) {
      // Lost stage — open modal to capture reason before committing
      setPendingLost({ ticket, fromStageId: ticket.stageId, toStage });
      return;
    }

    move.mutate({
      ticketId: ticket.id,
      fromStageId: ticket.stageId,
      toStageId,
      pipelineId: pipeline.id,
      optimisticTicket: ticket,
    });
  };

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div
          style={{
            display: "flex",
            gap: 12,
            padding: 12,
            overflowX: "auto",
            height: "100%",
            scrollSnapType: "x mandatory",
          }}
        >
          {pipeline.stages.map((stage) => (
            <div key={stage.id} style={{ scrollSnapAlign: "start", height: "100%" }}>
              <StageColumn
                stage={stage}
                pipelineId={pipeline.id}
                lang={lang}
                ownerFilter={ownerFilter}
                searchQuery={searchQuery}
                onCardClick={onCardClick}
                onOpenConversation={onOpenConversation}
              />
            </div>
          ))}
        </div>

        <DragOverlay>
          {activeTicket ? (
            <TicketCard ticket={activeTicket} lang={lang} isDragging />
          ) : null}
        </DragOverlay>
      </DndContext>

      {pendingLost ? (
        <LostReasonModal
          lang={lang}
          ticket={pendingLost.ticket}
          onCancel={() => setPendingLost(null)}
          onConfirm={(reason) => {
            move.mutate({
              ticketId: pendingLost.ticket.id,
              fromStageId: pendingLost.fromStageId,
              toStageId: pendingLost.toStage.id,
              pipelineId: pipeline.id,
              lostReason: reason,
              optimisticTicket: pendingLost.ticket,
            });
            setPendingLost(null);
          }}
        />
      ) : null}
    </>
  );
}
