import { Injectable, Logger } from "@nestjs/common";
import { NotificationsService } from "../notifications/notifications.service";
import { PermissionService } from "../permissions/permission.service";
import { PrismaService } from "../prisma/prisma.service";

/** The notification's title key (frontend: `notificationText.ts`). */
export const META_ADS_RECONNECT_TITLE = "meta_ads.needs_reconnect";
/** Who hears it (ruling 7). */
export const META_ADS_ALERT_PERMISSION = "connectors.manage";

export type ReconnectReason = "token_refused" | "account_refused";

/** What `body` holds (JSON-encoded, SP-05). */
export interface ReconnectBody {
  reason: ReconnectReason;
  adAccountName: string | null;
}

/**
 * SP-15 reconnect alert. `park` moves a connection `active → needs_reconnect`
 * in one conditional update; only the caller that wins the transition
 * notifies, so a refusal notifies once until a reconnect (save) makes the
 * connection active again. `tokenEnc` fences the write: a refusal of an old
 * token never parks a connection that was reconnected meanwhile.
 */
@Injectable()
export class MetaAdsNotifier {
  private readonly log = new Logger(MetaAdsNotifier.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly permissions: PermissionService,
  ) {}

  /** Returns true when this call made the transition (and notified). */
  async park(
    conn: { id: string; workspaceId: string; tokenEnc: string | null; adAccountName: string | null },
    reason: ReconnectReason,
  ): Promise<boolean> {
    const won = await this.prisma.metaAdsConnection.updateMany({
      where: { id: conn.id, workspaceId: conn.workspaceId, status: "active", tokenEnc: conn.tokenEnc },
      data: { status: "needs_reconnect", statusReason: reason, lastSyncError: reason },
    });
    if (won.count !== 1) return false;
    const userIds = await this.permissions.membersWith(conn.workspaceId, META_ADS_ALERT_PERMISSION);
    if (userIds.length === 0) {
      this.log.log(`meta ads connection ${conn.id} needs reconnecting; nobody holds ${META_ADS_ALERT_PERMISSION}`);
      return true;
    }
    const body: ReconnectBody = { reason, adAccountName: conn.adAccountName ?? null };
    await this.notifications.notify(conn.workspaceId, userIds, {
      type: "connector_needs_attention",
      title: META_ADS_RECONNECT_TITLE,
      body: JSON.stringify(body),
    });
    return true;
  }
}
