import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";
import { REFRESH_SWEEP_AHEAD_MS } from "./connector-catalog";
import { ConnectorTokenService } from "./connector-token.service";

/**
 * SP-23: hourly, refresh active OAuth connectors whose token expires within
 * two hours, one at a time (each under its own lock). `tick({workspaceIds})`
 * limits it for verification.
 */
@Injectable()
export class ConnectorRefreshScheduler {
  private readonly logger = new Logger(ConnectorRefreshScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: ConnectorTokenService,
  ) {}

  @Cron("33 * * * *")
  async scheduled(): Promise<void> {
    await this.tick();
  }

  async tick(opts: { now?: Date; workspaceIds?: string[] } = {}): Promise<number> {
    const now = opts.now ?? this.tokens.now();
    const due = await this.prisma.connector.findMany({
      where: {
        status: "active",
        authKind: "oauth",
        tokenExpiresAt: { not: null, lte: new Date(now.getTime() + REFRESH_SWEEP_AHEAD_MS) },
        ...(opts.workspaceIds ? { workspaceId: { in: opts.workspaceIds } } : {}),
      },
      orderBy: { tokenExpiresAt: "asc" },
      take: 200,
    });
    let done = 0;
    for (const row of due) {
      try {
        await this.tokens.refresh(row as never, { aheadMs: REFRESH_SWEEP_AHEAD_MS });
        done++;
      } catch (e) {
        this.logger.warn(`connector ${row.id} refresh sweep failed: ${(e as Error).name}`);
      }
    }
    return done;
  }
}
