import { ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsIn, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

const ALL_CHANNELS = ["facebook", "instagram"] as const;

export class CreateScheduledPostDto {
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
  channels!: (typeof ALL_CHANNELS)[number][];

  /** ISO-8601 string. Use a past/now value for "post immediately via the queue". */
  @IsDateString()
  scheduledFor!: string;
}
