import { Type } from "class-transformer";
import {
  IsIn,
  IsString,
  IsUUID,
  MinLength,
  ValidateNested,
} from "class-validator";

export class LMessagePayloadDto {
  @IsUUID() workspaceId!: string;
  @IsUUID() conversationId!: string;
  @IsUUID() agentId!: string;
  @IsString() @MinLength(1) userId!: string;
  @IsString() @MinLength(1) message!: string;
  @IsString() timestamp!: string; // ISO 8601
}

export class LMessageWebhookDto {
  @IsIn(["message.created"])
  event!: "message.created";

  @ValidateNested()
  @Type(() => LMessagePayloadDto)
  data!: LMessagePayloadDto;
}
