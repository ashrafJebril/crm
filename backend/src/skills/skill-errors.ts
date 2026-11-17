import { BadRequestException, ConflictException, HttpException, NotFoundException } from "@nestjs/common";

/** SP-22 route error keys and their HTTP status (`{statusCode, message: key, …extra}`). */
const STATUS = {
  "skills.invalid_config": 400,
  "skills.unknown": 404,
  "skills.not_installed": 404,
  "skills.already_installed": 409,
  "skills.agent_not_connected": 409,
  "skills.connector_required": 409,
  "skills.version_conflict": 409,
  "skills.config_required": 409,
  "skills.up_to_date": 409,
} as const;

/** Error keys the new MCP tools report (as the tool error text). */
export const SKILL_TOOL_ERROR_KEYS = ["skills.tag_not_allowed", "tickets.no_support_pipeline", "tickets.too_many_open"] as const;

export type SkillErrorKey = keyof typeof STATUS;
export const SKILL_ERROR_KEYS = Object.keys(STATUS) as SkillErrorKey[];

export function skillError(key: SkillErrorKey, extra: Record<string, unknown> = {}): HttpException {
  const statusCode = STATUS[key];
  const body = { statusCode, message: key, ...extra };
  if (statusCode === 400) return new BadRequestException(body);
  if (statusCode === 404) return new NotFoundException(body);
  return new ConflictException(body);
}

export function skillErrorStatus(key: SkillErrorKey): number {
  return STATUS[key];
}
