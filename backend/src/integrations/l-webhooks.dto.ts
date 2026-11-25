import { Type } from "class-transformer";
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MinLength,
  ValidateNested,
} from "class-validator";

/** An agent answer l mirrors into the inbox. */
export const L_MESSAGE_CREATED = "message.created";
/** A customer message l did not answer because our reply gate said no. */
export const L_MESSAGE_RECEIVED = "message.received";

export class LMessagePayloadDto {
  @IsUUID() workspaceId!: string;
  @IsUUID() conversationId!: string;
  @IsUUID() agentId!: string;
  @IsString() @MinLength(1) userId!: string;
  @IsString() @MinLength(1) message!: string;
  @IsOptional() @IsString() imageUrl?: string;
  @IsString() timestamp!: string; // ISO 8601
}

export class LMessageWebhookDto {
  @IsIn([L_MESSAGE_CREATED, L_MESSAGE_RECEIVED])
  event!: typeof L_MESSAGE_CREATED | typeof L_MESSAGE_RECEIVED;

  @ValidateNested()
  @Type(() => LMessagePayloadDto)
  data!: LMessagePayloadDto;
}

/** l asking, before it answers a chat that started on l, whether it may. */
export class LShouldReplyDto {
  @IsUUID() workspaceId!: string;
  @IsUUID() conversationId!: string;
  @IsUUID() agentId!: string;
  @IsString() @MinLength(1) userId!: string;
  @IsString() message!: string;
}
