import { IsIn, IsObject, IsOptional, IsString } from "class-validator";

export const TRIGGER_TYPES = [
  "contact_created",
  "message_received",
  "ticket_created",
  "ticket_stage_changed",
  "schedule",
  "webhook",
] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export class CreateWorkflowDto {
  @IsString() name!: string;
  @IsIn(TRIGGER_TYPES) triggerType!: TriggerType;
  @IsOptional() @IsObject() triggerConfig?: Record<string, unknown>;
  @IsOptional() @IsObject() steps?: unknown;
}

export class UpdateWorkflowDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsIn(TRIGGER_TYPES) triggerType?: TriggerType;
  @IsOptional() @IsObject() triggerConfig?: Record<string, unknown>;
  @IsOptional() @IsObject() steps?: unknown;
}

export class TestWorkflowDto {
  @IsOptional() @IsObject() payload?: Record<string, unknown>;
}
