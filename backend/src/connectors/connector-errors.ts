import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from "@nestjs/common";

/** SP-23 connector error keys (`{statusCode, message: key, …extra}`). The
 *  frontend has copy for every key. */
const STATUS = {
  "connectors.provider_unavailable": 400,
  "connectors.encryption_unavailable": 400,
  "connectors.unsafe_url": 400,
  "connectors.check_failed": 400,
  "connectors.tool_removed": 400,
  "connectors.invalid_tools": 400,
  "connectors.write_access_requires_manage": 403,
  "connectors.not_found": 404,
  "connectors.custom_limit": 409,
  "connectors.version_conflict": 409,
  "connectors.disconnected": 409,
  "connectors.needs_reconnect": 409,
  "connectors.agent_not_connected": 409,
} as const;

export type ConnectorErrorKey = keyof typeof STATUS;
export const CONNECTOR_ERROR_KEYS = Object.keys(STATUS) as ConnectorErrorKey[];
/** OAuth hand-off outcomes (`connected=0&reason=`), used by Task 2. */
export const CONNECTOR_OAUTH_REASONS = ["invalid_state", "cancelled", "exchange_failed", "forbidden"] as const;

export function connectorError(key: ConnectorErrorKey, extra: Record<string, unknown> = {}): HttpException {
  const statusCode = STATUS[key];
  const body = { statusCode, message: key, ...extra };
  if (statusCode === 400) return new BadRequestException(body);
  if (statusCode === 403) return new ForbiddenException(body);
  if (statusCode === 404) return new NotFoundException(body);
  return new ConflictException(body);
}

export function connectorErrorStatus(key: ConnectorErrorKey): number {
  return STATUS[key];
}
