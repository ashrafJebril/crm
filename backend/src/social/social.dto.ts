import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsISO8601, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

const ALL_CHANNELS = ["facebook", "instagram", "tiktok"] as const;
export type PublishChannel = (typeof ALL_CHANNELS)[number];

export class PublishDto {
  @IsString()
  @MinLength(1)
  @MaxLength(63206)
  content!: string;

  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @IsOptional()
  mediaIds?: string[];

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(ALL_CHANNELS.length)
  @IsIn(ALL_CHANNELS, { each: true })
  channels!: PublishChannel[];

  /** ISO 8601 instant. Present = schedule instead of publish immediately. */
  @IsOptional()
  @IsISO8601()
  scheduledFor?: string;

  /** IANA timezone the user scheduled in (e.g. "Asia/Riyadh"). */
  @IsOptional()
  @IsString()
  timezone?: string;
}

export class RescheduleDto {
  @IsISO8601()
  scheduledFor!: string;

  @IsString()
  timezone!: string;
}
