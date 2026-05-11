import { IsOptional, IsString, MinLength } from "class-validator";

export class CreateNoteDto {
  @IsString()
  @MinLength(1)
  contactId!: string;

  @IsString()
  @IsOptional()
  conversationId?: string;

  @IsString()
  @IsOptional()
  ticketId?: string;

  @IsString()
  @MinLength(1)
  body!: string;
}

export class UpdateNoteDto {
  @IsString()
  @MinLength(1)
  body!: string;
}
