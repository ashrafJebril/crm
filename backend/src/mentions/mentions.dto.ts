import { IsIn, IsOptional, IsString } from "class-validator";

export const MENTION_STATUSES = ["new", "triaged", "engaged", "dismissed"] as const;
export type MentionStatus = (typeof MENTION_STATUSES)[number];

export class UpdateMentionDto {
  @IsIn(MENTION_STATUSES as unknown as string[])
  @IsOptional()
  status?: MentionStatus;
}

export class ListMentionsQuery {
  @IsString()
  @IsOptional()
  status?: string;

  @IsString()
  @IsOptional()
  keywordId?: string;

  @IsString()
  @IsOptional()
  source?: string;
}
