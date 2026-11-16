import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
} from "@nestjs/common";

/**
 * SP-09 error keys. The `message` is the key itself (the frontend maps it
 * through `tx` in `src/screens/pipeline/ticketErrors.ts`); extras ride along.
 * Same shape as `channelError` / `mediaError`.
 */
export type TicketErrorKey =
  | "tickets.invalid_priority"
  | "tickets.invalid_category"
  | "tickets.attachments_full" // {limit}
  | "tickets.no_conversation"
  | "tickets.attachment_not_found"
  | "tickets.attachment_source_not_found"
  | "tickets.attachment_exists"
  | "tickets.no_resolved_stage"
  | "tickets.already_closed"
  | "tickets.stage_changed";

export const TICKET_ERROR_STATUS: Record<TicketErrorKey, 400 | 404 | 409> = {
  "tickets.invalid_priority": 400,
  "tickets.invalid_category": 400,
  "tickets.attachments_full": 400,
  "tickets.no_conversation": 400,
  "tickets.attachment_not_found": 404,
  "tickets.attachment_source_not_found": 404,
  "tickets.attachment_exists": 409,
  "tickets.no_resolved_stage": 409,
  "tickets.already_closed": 409,
  "tickets.stage_changed": 409,
};

export const TICKET_ERROR_KEYS = Object.keys(TICKET_ERROR_STATUS) as TicketErrorKey[];

export function ticketError(key: TicketErrorKey, extra: Record<string, unknown> = {}): HttpException {
  const statusCode = TICKET_ERROR_STATUS[key];
  const body = { statusCode, message: key, ...extra };
  if (statusCode === 404) return new NotFoundException(body);
  if (statusCode === 409) return new ConflictException(body);
  return new BadRequestException(body);
}
