import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from "class-validator";

export const NOTIFICATION_TYPES = [
  "assignment",
  "mention",
  "activity_due",
  "connector_needs_attention",
  "knowledge_source_failed",
  "campaign_finished",
  "import_finished",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const RECORD_KINDS = [
  "contact",
  "conversation",
  "ticket",
  "booking",
  "campaign",
] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

export interface NotifyInput {
  type: NotificationType;
  /** Stable message key, e.g. "assignment.conversation". The UI maps it to text. */
  title: string;
  /** JSON-encoded params for the message key. */
  body?: string;
  recordKind?: RecordKind;
  recordId?: string;
  actorId?: string;
}

export class ListNotificationsQuery {
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

export class MarkReadDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  ids?: string[];

  @IsOptional()
  @IsBoolean()
  all?: boolean;
}

export class PreferenceItemDto {
  @IsIn(NOTIFICATION_TYPES as unknown as string[])
  type!: NotificationType;

  @IsBoolean()
  inApp!: boolean;

  @IsBoolean()
  sound!: boolean;
}

export class UpdatePreferencesDto {
  @IsArray()
  @ArrayMaxSize(NOTIFICATION_TYPES.length)
  @ValidateNested({ each: true })
  @Type(() => PreferenceItemDto)
  items!: PreferenceItemDto[];
}
