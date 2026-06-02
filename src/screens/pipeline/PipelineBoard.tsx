import { useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  closestCorners,
  useSensor,
  useSensors,
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

  const handleDragStart = (e: DragStartEvent) => {
    const ticket = e.active.data.current?.ticket as Ticket | undefined;
    if (ticket) setActiveTicket(ticket);
  };

  const handleDragEnd = (e: DragEndEvent) => {
    setActiveTicket(null);
    const ticket = e.active.data.current?.ticket as Ticket | undefined;
    const toStageId = (e.over?.data.current?.stageId as string | undefined) ?? null;
    if (!ticket || !toStageId || toStageId === ticket.stageId) return;
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
        collisionDetection={closestCorners}
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
