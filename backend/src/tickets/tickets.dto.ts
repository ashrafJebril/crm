import {
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from "class-validator";

export class CreateTicketDto {
  @IsString() @IsNotEmpty() pipelineId!: string;
  @IsString() @IsNotEmpty() stageId!: string;
  @IsString() @IsNotEmpty() contactId!: string;
  @IsString() @IsNotEmpty() title!: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsNumber() @Min(0) value?: number;
  @IsOptional() @IsString() ownerId?: string;
  @IsOptional() @IsString() conversationId?: string;
}

export class UpdateTicketDto {
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsNumber() @Min(0) value?: number;
  @IsOptional() @IsString() ownerId?: string;
}

export class MoveTicketDto {
  @IsString() @IsNotEmpty() stageId!: string;
  @IsOptional() @IsString() lostReason?: string;
  @IsOptional() @IsString() note?: string;
  @IsOptional() @IsString() byUserId?: string;
}

export class AddNoteDto {
  @IsString() @IsNotEmpty() note!: string;
  @IsOptional() @IsString() byUserId?: string;
}

export class ListTicketsQuery {
  @IsOptional() @IsString() pipelineId?: string;
  @IsOptional() @IsString() stageId?: string;
  @IsOptional() @IsString() contactId?: string;
  @IsOptional() @IsString() ownerId?: string;
  @IsOptional() @IsInt() @Min(1) limit?: number;
}
