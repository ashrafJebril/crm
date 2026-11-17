import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";
import { AGENT_TOOL_CALL_RETENTION_DAYS } from "./skill-catalog";

export const PRUNE_BATCH = 5_000;
const DAY = 86_400_000;

/** SP-22 (ruling 12): the usage log keeps 90 days. Daily, off the request
 *  path, in batches of 5 000. */
@Injectable()
export class AgentToolCallPruneScheduler {
  private readonly logger = new Logger(AgentToolCallPruneScheduler.name);
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  @Cron("17 3 * * *")
  async daily(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const n = await this.prune({ before: new Date(Date.now() - AGENT_TOOL_CALL_RETENTION_DAYS * DAY) });
      if (n) this.logger.log(`pruned ${n} agent tool calls`);
    } catch (e) {
      this.logger.warn(`agent tool call prune failed: ${(e as Error)?.message}`);
    } finally {
      this.running = false;
    }
  }

  /** Deletes rows older than `before` (optionally only of `workspaceIds`). Returns how many. */
  async prune(opts: { before: Date; workspaceIds?: string[] }): Promise<number> {
    const where = {
      at: { lt: opts.before },
      ...(opts.workspaceIds ? { workspaceId: { in: opts.workspaceIds } } : {}),
    };
    let total = 0;
    for (;;) {
      const batch = await this.prisma.raw.agentToolCall.findMany({ where, select: { id: true }, take: PRUNE_BATCH });
      if (batch.length === 0) break;
      const res = await this.prisma.raw.agentToolCall.deleteMany({ where: { id: { in: batch.map((r) => r.id) } } });
      total += res.count;
      if (batch.length < PRUNE_BATCH) break;
    }
    return total;
  }
}
