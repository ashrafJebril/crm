import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { RECIPIENT_STATUSES, type RecipientStatus } from "./tracking/recipient-status";

/** Ticked rows in one export (SP-03's EXPORT_IDS_CAP). */
export const EXPORT_IDS_CAP = 10_000;
/** Ticked rows in one follow-up action (Tkana's MAX_POSTED_IDS). */
export const FOLLOW_UP_IDS_CAP = 5_000;
export const RECIPIENTS_PAGE_MAX = 200;
export const RECIPIENTS_PAGE_DEFAULT = 50;
export const EXPORT_LANGS = ["en", "ar"] as const;
export type ExportLang = (typeof EXPORT_LANGS)[number];

const Trim = Transform(({ value }) => (typeof value === "string" ? value.trim() : value));
const STATUS_OPTS = { message: "campaigns.invalid_status" };

export class RecipientsQueryDto {
  @IsOptional() @IsIn([...RECIPIENT_STATUSES], STATUS_OPTS) status?: RecipientStatus;
  @IsOptional() @IsString() @MaxLength(512) cursor?: string;
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "campaigns.invalid_limit" })
  @Min(1, { message: "campaigns.invalid_limit" })
  @Max(RECIPIENTS_PAGE_MAX, { message: "campaigns.invalid_limit" })
  limit?: number;
}

export class ExportQueryDto {
  @IsOptional() @IsIn([...RECIPIENT_STATUSES], STATUS_OPTS) status?: RecipientStatus;
  @IsOptional() @IsIn([...EXPORT_LANGS]) lang?: ExportLang;
}

/** POST export: the ticked rows in a JSON body, so a large selection doesn't hit URL limits. */
export class ExportBodyDto extends ExportQueryDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(EXPORT_IDS_CAP, { message: "campaigns.ids_too_many" })
  @IsString({ each: true })
  ids?: string[];
}

/** Exactly one of `status` (a whole outcome) or `ids` (ticked rows); the service enforces "exactly one". */
class FollowUpTargetDto {
  @IsOptional() @IsIn([...RECIPIENT_STATUSES], STATUS_OPTS) status?: RecipientStatus;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(FOLLOW_UP_IDS_CAP, { message: "campaigns.ids_too_many" })
  @IsString({ each: true })
  ids?: string[];
}

export class CreateGroupDto extends FollowUpTargetDto {
  // Fix m3: every constraint carries the key, so no generic text can lead the 400's message list.
  @Trim
  @IsString({ message: "campaigns.group_name_required" })
  @IsNotEmpty({ message: "campaigns.group_name_required" })
  @Length(1, 120, { message: "campaigns.group_name_required" })
  name!: string;
  @Trim @IsOptional() @IsString() @MaxLength(120) nameAr?: string;
}

export class AddToGroupDto extends FollowUpTargetDto {
  @IsString() @IsNotEmpty() groupId!: string;
}

export class TagFollowUpDto extends FollowUpTargetDto {
  @IsString() @IsNotEmpty() tagId!: string;
}
