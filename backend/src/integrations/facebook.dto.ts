import {
  ArrayMaxSize,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";

export class ConnectFacebookDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(20, { message: "Token looks too short to be a Page Access Token" })
  accessToken!: string;
}

export class ReplyToCommentDto {
  @IsString()
  @IsNotEmpty()
  message!: string;
}

export class EditPostDto {
  @IsString()
  @MinLength(1)
  @MaxLength(63206)
  message!: string;
}

export class PublishToPageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(63206) // FB feed post max
  content!: string;

  // Optional list of Media ids. Phase 1: 0 or 1 supported. More than 1 is
  // accepted by the DTO but currently posted as a single-photo post using
  // only the first id (multi-image is Phase 3 work).
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @IsOptional()
  mediaIds?: string[];
}
