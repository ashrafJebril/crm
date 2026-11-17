import { Injectable, Logger } from "@nestjs/common";
import { PermissionService } from "../permissions/permission.service";
import { NotificationsService } from "../notifications/notifications.service";
import { ConnectorStatusService } from "./connector-status.service";

export const CONNECTOR_ATTENTION_PERMISSION = "connectors.manage";
export const CONNECTOR_NEEDS_RECONNECT_TITLE = "connectors.needs_reconnect";

export type AttentionReason = "invalid_grant" | "no_refresh_token" | "refresh_failed" | "upstream_unauthorized";

/**
 * SP-23 needs attention: `active → needs_reconnect` by compare-and-set (the
 * meta-ads-notifier pattern). Only the winner notifies members holding
 * connectors.manage, once (`connector_needs_attention`, title
 * `connectors.needs_reconnect`, body {provider, name, reason}); the status
 * service has already told skills. The proxy then lists no tools.
 */
@Injectable()
export class ConnectorAttentionService {
  private readonly logger = new Logger(ConnectorAttentionService.name);

  constructor(
    private readonly status: ConnectorStatusService,
    private readonly perms: PermissionService,
    private readonly notifications: NotificationsService,
  ) {}

  async markNeedsReconnect(conn: { id: string; workspaceId: string; provider: string; name: string }, reason: AttentionReason): Promise<boolean> {
    const won = await this.status.set(conn, "needs_reconnect", reason, ["active"]);
    if (!won) return false;
    this.logger.warn(`connector ${conn.id} (${conn.provider}) needs reconnecting: ${reason}`);
    try {
      const userIds = await this.perms.membersWith(conn.workspaceId, CONNECTOR_ATTENTION_PERMISSION);
      await this.notifications.notify(conn.workspaceId, userIds, {
        type: "connector_needs_attention",
        title: CONNECTOR_NEEDS_RECONNECT_TITLE,
        body: JSON.stringify({ provider: conn.provider, name: conn.name, reason, connectorId: conn.id }),
      });
    } catch (e) {
      this.logger.warn(`connector attention notification failed: ${(e as Error).message}`);
    }
    return true;
  }
}
