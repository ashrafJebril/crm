import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from "class-validator";

export class CreateTicketDto {
  @IsString() @IsNotEmpty() pipelineId!: string;
  @IsString() @IsNotEmpty() stageId!: string;
  @IsString() @IsNotEmpty() contactId!: string;
  @IsString() @IsNotEmpty() title!: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsNumber() @Min(0) value?: number;
  @IsOptional() @IsString() ownerId?: string;
  @IsOptional() @IsString() conversationId?: string;
}

export class UpdateTicketDto {
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsNumber() @Min(0) value?: number;
  @IsOptional() @IsString() ownerId?: string;
}

export class MoveTicketDto {
  @IsString() @IsNotEmpty() stageId!: string;
  @IsOptional() @IsString() lostReason?: string;
  /** SP-07: a LostReason of the ticket's pipeline; its label becomes the lostReason snapshot. */
  @IsOptional() @IsString() lostReasonId?: string;
  @IsOptional() @IsString() note?: string;
  @IsOptional() @IsString() byUserId?: string;
}

export class AddNoteDto {
  @IsString() @IsNotEmpty() note!: string;
  @IsOptional() @IsString() byUserId?: string;
}

export class ListTicketsQuery {
  @IsOptional() @IsString() pipelineId?: string;
  @IsOptional() @IsString() stageId?: string;
  @IsOptional() @IsString() contactId?: string;
  @IsOptional() @IsString() conversationId?: string;
  /** A user id, or "none" for unassigned. */
  @IsOptional() @IsString() ownerId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @IsString() cursor?: string;

  // SP-08 board filters (shared by the table and the kanban)
  @IsOptional() @IsIn(["open", "won", "lost"]) status?: "open" | "won" | "lost";
  @IsOptional() @IsString() q?: string;
  /** Inclusive local days (YYYY-MM-DD) in the workspace timezone, on createdAt. */
  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsString() to?: string;
  /** "table" switches to the sorted, keyset-paged response with a total. */
  @IsOptional() @IsIn(["table"]) view?: "table";
  @IsOptional() @IsIn(["createdAt", "updatedAt", "value", "enteredStageAt"]) sort?: "createdAt" | "updatedAt" | "value" | "enteredStageAt";
  @IsOptional() @IsIn(["asc", "desc"]) dir?: "asc" | "desc";
}

export const TICKET_BULK_OPS = ["assign", "lost", "notALead"] as const;
export const TICKET_BULK_CAP = 500;

export class BulkTicketsDto {
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(TICKET_BULK_CAP) @IsString({ each: true }) ids!: string[];
  @IsIn(TICKET_BULK_OPS as unknown as string[]) op!: (typeof TICKET_BULK_OPS)[number];
  /** assign: a member user id, or null to unassign. */
  @IsOptional() @IsString() ownerId?: string | null;
  /** lost: a LostReason of each ticket's pipeline. */
  @IsOptional() @IsString() lostReasonId?: string;
}

export class CreateFromConversationDto {
  @IsString() @IsNotEmpty() pipelineId!: string;
  @IsString() @IsNotEmpty() stageId!: string;
  @IsString() @IsNotEmpty() title!: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsNumber() @Min(0) value?: number;
  @IsOptional() @IsString() ownerId?: string;
}
