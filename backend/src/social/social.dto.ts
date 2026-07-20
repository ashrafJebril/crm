import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

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
}
