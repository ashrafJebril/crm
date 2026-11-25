import { Injectable, Logger, Optional } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { SkillsService } from "../skills/skills.service";
import type { ConnectorProvider } from "../skills/skill-catalog";
import { CONNECTOR_PROVIDERS } from "./connector-catalog";

export type ConnectorStatus = "pending" | "active" | "needs_reconnect" | "disconnected";

/**
 * SP-23: the one place a connector's status changes. `from` makes it a
 * compare-and-set (only the winner returns true, so only one caller
 * notifies). Every change tells SP-22 skills (`onConnectorChanged`).
 */
@Injectable()
export class ConnectorStatusService {
  private readonly logger = new Logger(ConnectorStatusService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly skills?: SkillsService,
  ) {}

  async set(
    conn: { id: string; workspaceId: string; provider: string },
    status: ConnectorStatus,
    reason: string | null,
    from?: ConnectorStatus[],
  ): Promise<boolean> {
    const res = await this.prisma.connector.updateMany({
      where: { id: conn.id, workspaceId: conn.workspaceId, ...(from ? { status: { in: from } } : { status: { not: status } }) },
      data: { status, statusReason: reason },
    });
    if (res.count > 0) await this.changed(conn.workspaceId, conn.provider);
    return res.count > 0;
  }

  /** Tells skills that a provider's presence may have changed. Never throws. */
  async changed(workspaceId: string, provider: string): Promise<void> {
    if (!this.skills || !(CONNECTOR_PROVIDERS as readonly string[]).includes(provider)) return;
    try {
      await this.skills.onConnectorChanged(workspaceId, provider as ConnectorProvider);
    } catch (e) {
      this.logger.warn(`skills not updated after a ${provider} connector change: ${(e as Error).message}`);
    }
  }
}
