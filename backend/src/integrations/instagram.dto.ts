import { ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

export class PublishToIgDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2200) // IG caption max
  content!: string;

  // Phase 2 supports exactly 0 or 1 image. Text-only IG posts are not allowed
  // by the Graph API (IG requires media on every post), so 0 will return 400.
  @IsArray()
  @ArrayMaxSize(1)
  @IsString({ each: true })
  @IsOptional()
  mediaIds?: string[];
}
