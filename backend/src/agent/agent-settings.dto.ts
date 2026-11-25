/**
 * SP-20 agent settings DTOs. Request bodies run through the global
 * ValidationPipe (`whitelist`, `forbidNonWhitelisted`): an unknown field is a
 * 400. Rules with their own error key (names, tones, schedule, tags, version)
 * live in the service.
 */
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { AGENT_NAME_MAX, AGENT_TONES, EXCLUDED_TAGS_MAX, GREETING_MAX, HOURS_MODES, type HoursMode, type PublishState } from "./agent-constants";
import type { WeeklySchedule } from "../bookings/schedule";

export class AgentIdentityDto {
  @IsOptional() @IsString() @MaxLength(AGENT_NAME_MAX) nameEn?: string;
  @IsOptional() @IsString() @MaxLength(AGENT_NAME_MAX) nameAr?: string;
  @IsOptional() @IsString() @MaxLength(GREETING_MAX) greeting?: string;
  @IsOptional() @IsString() @MaxLength(GREETING_MAX) greetingAr?: string;
  /** Checked against AGENT_TONES in the service (400 `agent.tone_invalid`). */
  @IsOptional() @IsArray() @ArrayMaxSize(AGENT_TONES.length) @IsString({ each: true }) tone?: string[];
}

export class AgentHoursDto {
  @IsIn(HOURS_MODES as unknown as string[]) mode!: HoursMode;
  /** SP-10 WeeklySchedule; validated in the service (422 `agent.hours_invalid`). */
  @IsOptional() @IsObject() schedule?: Record<string, unknown>;
}

export class AgentAudienceDto {
  @IsArray() @ArrayMaxSize(EXCLUDED_TAGS_MAX) @IsString({ each: true }) excludedTagIds!: string[];
}

/** `PATCH /agent/settings`: one card per request is allowed but not required. */
export class PatchAgentSettingsDto {
  @IsOptional() @ValidateNested() @Type(() => AgentIdentityDto) identity?: AgentIdentityDto;
  @IsOptional() @ValidateNested() @Type(() => AgentHoursDto) hours?: AgentHoursDto;
  @IsOptional() @ValidateNested() @Type(() => AgentAudienceDto) audience?: AgentAudienceDto;
  @Type(() => Number) @IsInt() @Min(0) version!: number;
}

export interface AgentSettingsDto {
  nameEn: string | null;
  nameAr: string | null;
  greeting: string | null;
  greetingAr: string | null;
  tone: string[];
  hoursMode: HoursMode;
  schedule: WeeklySchedule | null;
  excludedTags: { id: string; name: string }[];
  /** Ids of excluded tags deleted from the catalog, dropped by this read. */
  droppedTagIds: string[];
  stopped: { at: string; reason: string | null; by: { id: string; name: string } | null } | null;
  timezone: string;
  publishState: PublishState;
  linked: boolean;
  version: number;
}

export interface AgentResyncDto {
  mcpServer: "created" | "already-present" | "not_linked";
  prompt: "updated" | "already-present" | "not_linked";
  persona: "updated" | "already-present" | "not_linked";
}
