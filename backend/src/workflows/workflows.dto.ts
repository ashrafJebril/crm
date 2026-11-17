import { IsIn, IsObject, IsOptional, IsString } from "class-validator";

export const TRIGGER_TYPES = [
  "contact_created",
  "message_received",
  "ticket_created",
  "ticket_stage_changed",
  "schedule",
  "webhook",
  "appointment_completed",
  // Sent by connected systems (hjz-v2) through /webhooks/hjz/sales.
  "sale_completed",
  // SP-24 lifecycle triggers.
  "appointment_confirmed",
  "appointment_cancelled",
  "appointment_reminder_due",
  "ticket_resolved",
] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

/** SP-24: triggers only system (lifecycle) workflows use; never user-chosen. */
export const SYSTEM_ONLY_TRIGGER_TYPES = ["appointment_reminder_due"] as const;
/** What a user workflow may choose (create / update validation). */
export const USER_TRIGGER_TYPES = TRIGGER_TYPES.filter(
  (t) => !(SYSTEM_ONLY_TRIGGER_TYPES as readonly string[]).includes(t),
) as Exclude<TriggerType, (typeof SYSTEM_ONLY_TRIGGER_TYPES)[number]>[];

export class CreateWorkflowDto {
  @IsString() name!: string;
  @IsIn(USER_TRIGGER_TYPES) triggerType!: TriggerType;
  @IsOptional() @IsObject() triggerConfig?: Record<string, unknown>;
  @IsOptional() @IsObject() steps?: unknown;
}

export class UpdateWorkflowDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsIn(USER_TRIGGER_TYPES) triggerType?: TriggerType;
  @IsOptional() @IsObject() triggerConfig?: Record<string, unknown>;
  @IsOptional() @IsObject() steps?: unknown;
}

export class TestWorkflowDto {
  @IsOptional() @IsObject() payload?: Record<string, unknown>;
}
