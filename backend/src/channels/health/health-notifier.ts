import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type { Channel } from "@prisma/client";
import { NotificationsService } from "../../notifications/notifications.service";
import { PermissionService } from "../../permissions/permission.service";
import { ChannelHealthService } from "./channel-health.service";
import { alertLevel, UNLIMITED_LEVEL, type AlertChange } from "./health-alerts";
import { asChannelHealth, tierCap, type AlertSignal, type ChannelHealth } from "./health-model";

/** The notification's title key (frontend: `notificationText.ts`). */
export const HEALTH_DOWNGRADED_TITLE = "channel.health_downgraded";
/** Who hears a downgrade (ruling 8): members whose effective role grants it. */
export const HEALTH_ALERT_PERMISSION = "channels.update";

/** One dropped signal, worded by the frontend from `to` (and `from` when shown). */
export interface DowngradeChange {
  signal: AlertSignal;
  /** The previous value (e.g. "GREEN", "TIER_10K"), or the previous level when no value maps to it. */
  from: string | number;
  /** The new value (e.g. "YELLOW"), or the paused + disabled count for templatesBad. */
  to: string | number;
}

/** What `body` holds (JSON-encoded, SP-05). */
export interface DowngradeBody {
  channelId: string;
  name: string;
  phone: string | null;
  changes: DowngradeChange[];
}

/** A level's canonical value, for signals where one level is one value. */
const CANONICAL: Partial<Record<AlertSignal, Record<number, string>>> = {
  quality: { 0: "GREEN", 1: "YELLOW", 2: "RED" },
  messaging: { 0: "AVAILABLE", 1: "LIMITED", 2: "BLOCKED" },
};
const TIER_BY_CAP: Record<number, string> = {
  50: "TIER_50",
  250: "TIER_250",
  1_000: "TIER_1K",
  2_000: "TIER_2K",
  10_000: "TIER_10K",
  100_000: "TIER_100K",
};

/**
 * `AlertChange.from` is the previously notified level (Task 1). The body
 * carries the previous value instead: the previous snapshot's value (or its
 * last known one) when it has that level, else the level's canonical value
 * (quality, messaging, tier), else the level itself.
 */
export function previousValue(signal: AlertSignal, level: number | string, previous: ChannelHealth | null): string | number {
  if (signal === "templatesBad") return level;
  if (previous) {
    const candidates = [previous[signal]?.value, previous.lastKnown?.[signal]?.value];
    for (const v of candidates) if (v !== undefined && alertLevel(signal, v) === level) return v as string;
  }
  if (signal === "tier") {
    if (level === UNLIMITED_LEVEL) return "TIER_UNLIMITED";
    const name = TIER_BY_CAP[Number(level)];
    if (name && tierCap(name) === Number(level)) return name;
    return String(level);
  }
  return CANONICAL[signal]?.[Number(level)] ?? level;
}

/**
 * SP-14 downgrade alerts (ruling 8). Bound as `ChannelHealthService.onDowngrade`,
 * which fires only after a won fenced write that found downgrades, so each
 * downgrade notifies at most once. One `connector_needs_attention`
 * notification per check lists every dropped signal; it goes to the
 * `channels.update` holders through `NotificationsService.notify`, which
 * honours in-app preferences. No `recordKind` (`channel` is not a
 * RecordKind); the frontend deep-links `#/channels?id=<channelId>`.
 */
@Injectable()
export class HealthNotifier implements OnModuleInit {
  private readonly log = new Logger(HealthNotifier.name);

  constructor(
    private readonly health: ChannelHealthService,
    private readonly notifications: NotificationsService,
    private readonly permissions: PermissionService,
  ) {}

  onModuleInit(): void {
    this.health.onDowngrade = (e) => this.onDowngrade(e.channel.workspaceId, e.channel, e.changes).then(() => undefined);
  }

  /**
   * `channel` is the row as read before the write, so its `health` is the
   * previous snapshot (used to word `from`). Returns the notifications created.
   */
  async onDowngrade(
    workspaceId: string,
    channel: Pick<Channel, "id" | "displayName" | "phoneNumber"> & { health?: unknown },
    changes: AlertChange[],
  ): Promise<number> {
    if (changes.length === 0) return 0;
    const userIds = await this.permissions.membersWith(workspaceId, HEALTH_ALERT_PERMISSION);
    if (userIds.length === 0) {
      this.log.log(`channel ${channel.id} downgraded; nobody holds ${HEALTH_ALERT_PERMISSION}`);
      return 0;
    }
    const previous = asChannelHealth(channel.health ?? null);
    const body: DowngradeBody = {
      channelId: channel.id,
      name: channel.displayName,
      phone: channel.phoneNumber ?? null,
      changes: changes.map((c) => ({ signal: c.signal, from: previousValue(c.signal, c.from, previous), to: c.to })),
    };
    return this.notifications.notify(workspaceId, userIds, {
      type: "connector_needs_attention",
      title: HEALTH_DOWNGRADED_TITLE,
      body: JSON.stringify(body),
    });
  }
}
