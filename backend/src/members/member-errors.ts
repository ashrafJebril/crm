import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from "@nestjs/common";

/** SP-26 member/invitation error keys and their HTTP status. The frontend
 *  (src/screens/team/memberErrors.ts) has copy for every key. */
const STATUS = {
  "invitations.invalid_email": 400,
  "invitations.email_mismatch": 403,
  "invitations.role_above_actor": 403,
  "invitations.not_found": 404,
  "members.not_found": 404,
  "workspaces.slug_not_found": 404,
  "invitations.already_member": 409,
  "invitations.pending_exists": 409,
  "invitations.sign_in_required": 409,
  "members.handover_required": 409,
  "members.handover_refused": 409,
  "invitations.invalid": 410,
  "invitations.resend_limited": 429,
  "email.not_configured": 503,
} as const;

export type MemberErrorKey = keyof typeof STATUS;
export const MEMBER_ERROR_KEYS = Object.keys(STATUS) as MemberErrorKey[];

export function memberError(key: MemberErrorKey, extra: Record<string, unknown> = {}): HttpException {
  const statusCode = STATUS[key];
  const body = { statusCode, message: key, ...extra };
  if (statusCode === 400) return new BadRequestException(body);
  if (statusCode === 403) return new ForbiddenException(body);
  if (statusCode === 404) return new NotFoundException(body);
  if (statusCode === 409) return new ConflictException(body);
  return new HttpException(body, statusCode);
}

export function memberErrorStatus(key: MemberErrorKey): number {
  return STATUS[key];
}
