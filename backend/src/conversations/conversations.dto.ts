import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
} from "class-validator";

const CHANNELS = ["whatsapp", "instagram", "facebook", "tiktok", "webchat"] as const;
const STATUSES = ["ai", "human", "closed", "spam"] as const;
const FROMS = ["them", "ai", "human"] as const;

export class CreateConversationDto {
  @IsString() @IsNotEmpty() contactId!: string;
  @IsString() @IsNotEmpty() agent!: string;
  @IsIn([...CHANNELS]) channel!: (typeof CHANNELS)[number];
  @IsIn([...STATUSES]) status!: (typeof STATUSES)[number];
  @IsString() preview!: string;
  @IsString() lastAt!: string;
  @IsIn([...FROMS]) lastFrom!: (typeof FROMS)[number];
  @IsString() intent!: string;
  @IsNumber() confidence!: number;
  @IsOptional() @IsBoolean() pinned?: boolean;
  @IsOptional() @IsBoolean() escalated?: boolean;
  @IsOptional() @IsString() suggested?: string;
}

export class UpdateConversationDto {
  @IsOptional() @IsIn([...STATUSES]) status?: (typeof STATUSES)[number];
  @IsOptional() @IsBoolean() pinned?: boolean;
  @IsOptional() @IsBoolean() escalated?: boolean;
  @IsOptional() @IsNumber() unread?: number;
  @IsOptional() @IsString() suggested?: string;
}

export class CreateMessageDto {
  @IsIn([...FROMS]) from!: (typeof FROMS)[number];
  @IsString() body!: string;
  @IsOptional() @IsString() agent?: string;
  @IsOptional() @IsString() attach?: string;
}
