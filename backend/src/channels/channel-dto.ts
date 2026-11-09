import type { Channel } from "@prisma/client";
import { healthCooldownMs } from "./health/health-config";
import { publicHealth, type ChannelHealthPublic } from "./health/health-model";

/**
 * The only shape a Channel leaves the server in. Built by whitelist, so a new
 * column (or a secret smuggled into `config`) never leaks by default:
 * secretsEnc, webhookSecretHash, integrationId, tokens and verify tokens are
 * never returned.
 */
export interface ChannelDto {
  id: string;
  kind: string;
  provider: string;
  externalId: string | null;
  displayName: string;
  phoneNumber: string | null;
  status: string;
  statusReason: string | null;
  isDefault: boolean;
  config: Record<string, unknown> | null;
  lastInboundAt: Date | null;
  createdAt: Date;
  conversationCount?: number;
  /** SP-14: the stored health without `alerts` and template items; null before the first check. */
  health: ChannelHealthPublic | null;
  /** SP-14: when the last health check finished (ISO). */
  healthCheckedAt: string | null;
  /** SP-14: when the next live check is allowed (ISO), or null when no cooldown is running. */
  healthNextCheckAt: string | null;
}

/** Non-secret config keys: widget, Meta and Telegram settings. */
export const PUBLIC_CONFIG_KEYS = [
  "allowedOrigins",
  "greeting",
  "greetingAr",
  "color",
  "position",
  "askName",
  "lang",
  "wabaId",
  "verification",
  "botUsername",
] as const;

export function publicConfig(config: unknown): Record<string, unknown> | null {
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  const src = config as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of PUBLIC_CONFIG_KEYS) if (src[k] !== undefined) out[k] = src[k];
  return out;
}

type ChannelRowLike = Pick<
  Channel,
  | "id"
  | "kind"
  | "provider"
  | "externalId"
  | "displayName"
  | "phoneNumber"
  | "status"
  | "statusReason"
  | "isDefault"
  | "lastInboundAt"
  | "createdAt"
> & {
  config?: unknown;
  // SP-14 (optional so narrow selects and older fakes still build a DTO).
  health?: unknown;
  healthCheckedAt?: Date | null;
  healthAttemptedAt?: Date | null;
};

const iso = (d: unknown): string | null => (d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : null);

export function toChannelDto(
  row: ChannelRowLike,
  extra: { conversationCount?: number } = {},
  now: Date = new Date(),
): ChannelDto {
  const attempted = row.healthAttemptedAt instanceof Date ? row.healthAttemptedAt.getTime() : null;
  const nextAt = attempted !== null ? attempted + healthCooldownMs() : null;
  return {
    id: row.id,
    kind: row.kind,
    provider: row.provider,
    externalId: row.externalId ?? null,
    displayName: row.displayName,
    phoneNumber: row.phoneNumber ?? null,
    status: row.status,
    statusReason: row.statusReason ?? null,
    isDefault: row.isDefault,
    config: publicConfig(row.config),
    lastInboundAt: row.lastInboundAt ?? null,
    createdAt: row.createdAt,
    ...(extra.conversationCount !== undefined ? { conversationCount: extra.conversationCount } : {}),
    health: publicHealth(row.health),
    healthCheckedAt: iso(row.healthCheckedAt),
    healthNextCheckAt: nextAt !== null && nextAt > now.getTime() ? new Date(nextAt).toISOString() : null,
  };
}
