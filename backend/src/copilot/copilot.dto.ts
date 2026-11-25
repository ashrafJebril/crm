/**
 * SP-18 copilot DTOs. Request bodies run through the global ValidationPipe
 * (`whitelist`, `forbidNonWhitelisted`): an unknown field is a 400. Rules with
 * their own error key (message length, the number of references) live in
 * the turn service so the client gets the key.
 */
import { Type } from "class-transformer";
import { IsArray, IsIn, IsOptional, IsString, MaxLength, ValidateNested } from "class-validator";
import { APPROVAL_MODES, PAGE_KEYS, REF_KINDS, type ApprovalMode, type PageKey, type RefKind } from "./copilot-constants";

export class CopilotRefDto {
  @IsIn(REF_KINDS as unknown as string[]) kind!: RefKind;
  @IsString() @MaxLength(64) id!: string;
}

export class PageContextDto {
  @IsIn(PAGE_KEYS as unknown as string[]) page!: PageKey;
  @IsOptional() @IsIn(["contact", "conversation", "ticket", "booking", "campaign"]) recordKind?: string;
  @IsOptional() @IsString() @MaxLength(64) recordId?: string;
  /** Insights pages: the range the member is looking at (the numbers are recomputed by the server). */
  @IsOptional() @IsString() @MaxLength(32) from?: string;
  @IsOptional() @IsString() @MaxLength(32) to?: string;
  @IsOptional() @IsString() @MaxLength(64) channelId?: string;
  @IsOptional() @IsString() @MaxLength(64) pipelineId?: string;
}

export class CopilotStreamDto {
  @IsOptional() @IsString() @MaxLength(64) sessionId?: string;
  /** 1..MESSAGE_MAX after trimming (400 `copilot.message_invalid`, checked in the service). */
  @IsString() message!: string;
  /** ≤ MAX_REFS (400 `copilot.too_many_refs`, checked in the service). */
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => CopilotRefDto) references?: CopilotRefDto[];
  /** Task 2 (attachments); ≤ ATTACH_MAX_PER_MESSAGE. */
  @IsOptional() @IsArray() @IsString({ each: true }) attachmentIds?: string[];
  @IsOptional() @ValidateNested() @Type(() => PageContextDto) pageContext?: PageContextDto;
  @IsIn(APPROVAL_MODES as unknown as string[]) approvalMode!: ApprovalMode;
  @IsIn(["en", "ar"]) lang!: "en" | "ar";
}

/** `POST /copilot/actions/:id/decline` (the note length has its own key, checked in the service). */
export class DeclineActionDto {
  @IsOptional() @IsString() note?: string;
}

export interface PendingCardDto {
  id: string;
  tool: string;
  title: string;
  changes: { label: string; before?: string; after: string }[];
  status: string;
  expiresAt: string;
  refusal: string | null;
  feedback: string | null;
  /** FAILED: why ("copilot.action_unknown" when the outcome could not be recorded). */
  errorKey: string | null;
  result?: unknown;
}

export interface CopilotSessionDto {
  id: string;
  title: string | null;
  updatedAt: string;
  running: boolean;
}

export interface CopilotMessageDto {
  id: string;
  role: string;
  text: string;
  references: unknown;
  attachments: unknown;
  sources: unknown;
  createdAt: string;
}

export interface CopilotSessionDetailDto {
  id: string;
  title: string | null;
  running: boolean;
  tainted: boolean;
  messages: CopilotMessageDto[];
  actions: PendingCardDto[];
}

export interface CopilotSessionPage {
  items: CopilotSessionDto[];
  nextCursor: string | null;
}
