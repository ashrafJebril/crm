import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

export const ACTIVITY_KINDS = ["follow_up", "call", "meeting", "task", "note_log"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
/** Kinds that are open work and always need a due time. */
export const DUE_REQUIRED_KINDS: readonly string[] = ["follow_up", "task"];
export const BULK_MAX = 500;

export class CreateActivityDto {
  @IsIn(ACTIVITY_KINDS as unknown as string[])
  kind!: ActivityKind;

  @IsString()
  @MinLength(1)
  @MaxLength(300)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  notes?: string;

  @IsOptional()
  @IsDateString()
  dueAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  outcome?: string;

  @IsOptional()
  @IsString()
  assigneeId?: string;

  @IsOptional()
  @IsString()
  contactId?: string;

  @IsOptional()
  @IsString()
  ticketId?: string;

  @IsOptional()
  @IsString()
  bookingId?: string;
}

export class UpdateActivityDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  notes?: string | null;

  /** ISO string; null clears it (only allowed for kinds that do not need one). */
  @IsOptional()
  @IsDateString()
  dueAt?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  outcome?: string | null;

  /** null unassigns. */
  @IsOptional()
  @IsString()
  assigneeId?: string | null;
}

export class CompleteActivityDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  outcome?: string;
}

export class BulkActivitiesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BULK_MAX)
  @IsString({ each: true })
  ids!: string[];

  @IsIn(["done", "reassign", "reschedule"])
  op!: "done" | "reassign" | "reschedule";

  @IsOptional()
  @IsString()
  assigneeId?: string;

  @IsOptional()
  @IsDateString()
  dueAt?: string;
}

export class ListActivitiesQuery {
  @IsOptional()
  @IsString()
  contactId?: string;

  @IsOptional()
  @IsString()
  ticketId?: string;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class QueueQuery {
  @IsOptional()
  @IsIn(["mine", "team"])
  scope?: "mine" | "team";

  @IsOptional()
  @IsString()
  assigneeId?: string;

  @IsOptional()
  @IsIn(ACTIVITY_KINDS as unknown as string[])
  kind?: ActivityKind;

  @IsOptional()
  @IsString()
  pipelineId?: string;

  @IsOptional()
  @IsString()
  cursorUpcoming?: string;
}

export class NextStepsQuery {
  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.split(",").map((s) => s.trim()).filter(Boolean) : value))
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  contactIds?: string[];

  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.split(",").map((s) => s.trim()).filter(Boolean) : value))
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  ticketIds?: string[];
}
