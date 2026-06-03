import { useState } from "react";
import { StageColumn } from "./StageColumn";
import { MoveStageMenu } from "./MoveStageMenu";
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
  const [moveTarget, setMoveTarget] = useState<{
    ticket: Ticket;
    anchorRect: DOMRect;
  } | null>(null);
  const [pendingLost, setPendingLost] = useState<{
    ticket: Ticket;
    toStage: TicketStage;
  } | null>(null);

  const move = useMoveTicket();

  const handlePickStage = (ticket: Ticket, toStage: TicketStage) => {
    setMoveTarget(null);
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

  return (
    <>
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
          <div
            key={stage.id}
            style={{ scrollSnapAlign: "start", height: "100%" }}
          >
            <StageColumn
              stage={stage}
              pipelineId={pipeline.id}
              lang={lang}
              ownerFilter={ownerFilter}
              searchQuery={searchQuery}
              onCardClick={onCardClick}
              onOpenConversation={onOpenConversation}
              onOpenMoveMenu={(ticket, anchorRect) =>
                setMoveTarget({ ticket, anchorRect })
              }
            />
          </div>
        ))}
      </div>

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
    </>
  );
}
