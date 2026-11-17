import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import type { ConnectorPresence } from "../skills/connector-presence";
import type { ConnectorProvider } from "../skills/skill-catalog";

/**
 * SP-23: the real SP-22 `ConnectorPresence`. A provider counts as connected
 * when the workspace has a connector for it that is `active` and has usable
 * credentials (an OAuth connector needs a stored token). `needs_reconnect`,
 * `pending` and `disconnected` are not connected.
 */
@Injectable()
export class ConnectorPresenceService implements ConnectorPresence {
  constructor(private readonly prisma: PrismaService) {}

  async isConnected(workspaceId: string, provider: ConnectorProvider): Promise<boolean> {
    const rows = await this.prisma.connector.findMany({
      where: { workspaceId, provider, status: "active" },
      select: { authKind: true, tokenEnc: true },
    });
    return rows.some((r) => r.authKind !== "oauth" || !!r.tokenEnc);
  }
}
