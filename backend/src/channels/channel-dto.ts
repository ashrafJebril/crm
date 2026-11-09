import type { Channel } from "@prisma/client";

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
> & { config?: unknown };

export function toChannelDto(row: ChannelRowLike, extra: { conversationCount?: number } = {}): ChannelDto {
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
  };
}
