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
  MaxLength,
  Min,
} from "class-validator";
import { TICKET_CATEGORIES, TICKET_PRIORITIES } from "./ticket-fields";

/** SP-09: unknown values are refused (400 with the key), never defaulted. */
const PRIORITY_OPTS = { message: "tickets.invalid_priority" };
const CATEGORY_OPTS = { message: "tickets.invalid_category" };

export class CreateTicketDto {
  @IsString() @IsNotEmpty() pipelineId!: string;
  @IsString() @IsNotEmpty() stageId!: string;
  @IsString() @IsNotEmpty() contactId!: string;
  @IsString() @IsNotEmpty() title!: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsNumber() @Min(0) value?: number;
  @IsOptional() @IsString() ownerId?: string;
  @IsOptional() @IsString() conversationId?: string;
  /** SP-09: one of TICKET_PRIORITIES (default "normal"). */
  @IsOptional() @IsIn(TICKET_PRIORITIES as unknown as string[], PRIORITY_OPTS) priority?: string;
  /** SP-09: one of TICKET_CATEGORIES, or null for none. */
  @IsOptional() @IsIn(TICKET_CATEGORIES as unknown as string[], CATEGORY_OPTS) category?: string | null;
}

export class UpdateTicketDto {
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsNumber() @Min(0) value?: number;
  @IsOptional() @IsString() ownerId?: string;
  /** SP-09 */
  @IsOptional() @IsIn(TICKET_PRIORITIES as unknown as string[], PRIORITY_OPTS) priority?: string;
  /** SP-09: null clears the category. */
  @IsOptional() @IsIn(TICKET_CATEGORIES as unknown as string[], CATEGORY_OPTS) category?: string | null;
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
  @IsOptional()
  @IsIn(["createdAt", "updatedAt", "value", "enteredStageAt", "slaDueAt", "priority"])
  sort?: "createdAt" | "updatedAt" | "value" | "enteredStageAt" | "slaDueAt" | "priority";
  @IsOptional() @IsIn(["asc", "desc"]) dir?: "asc" | "desc";

  // SP-09 filters. Unknown values are ignored (never a 400 or a 500), and a
  // repeated param (`?priority=high&priority=urgent`) arrives as an array,
  // which is joined: no type check here on purpose (review M4); the filter
  // builder sanitizes every shape.
  /** CSV (or repeated params) of TICKET_PRIORITIES. */
  @IsOptional() priority?: string | string[];
  /** CSV (or repeated params) of TICKET_CATEGORIES. */
  @IsOptional() category?: string | string[];
  /** "overdue" | "due_soon" | "none"; repeated values are joined (so two different ones are ignored). */
  @IsOptional() sla?: string | string[];
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
  /** SP-09 */
  @IsOptional() @IsIn(TICKET_PRIORITIES as unknown as string[], PRIORITY_OPTS) priority?: string;
  @IsOptional() @IsIn(TICKET_CATEGORIES as unknown as string[], CATEGORY_OPTS) category?: string | null;
}

/** SP-09: `POST /tickets/:id/resolve`. */
export const RESOLVE_NOTE_MAX = 2000;
export class ResolveTicketDto {
  @IsOptional() @IsString() @MaxLength(RESOLVE_NOTE_MAX) note?: string;
}

/** SP-09: `POST /tickets/:id/attachments` (a customer file from the ticket's conversation). */
export class AttachTicketFileDto {
  @IsString() @IsNotEmpty() mediaId!: string;
}
