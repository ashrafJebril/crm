import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

export type CallOutcome = "ok" | "error" | "refused";
export type CallSource = "agent" | "sync" | "probe";

export interface ConnectorCallEntry {
  workspaceId: string;
  connectorId: string;
  tool: string;
  kind: "read" | "write";
  outcome: CallOutcome;
  errorCode?: string | null;
  durationMs: number;
  source?: CallSource;
}

/**
 * SP-23: one `ConnectorCall` row per proxied call: the tool, its kind, the
 * outcome and a short error code. Never the arguments, never the result
 * (customer data stays out of the log). Never throws.
 */
@Injectable()
export class ConnectorCallRecorder {
  private readonly logger = new Logger(ConnectorCallRecorder.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(e: ConnectorCallEntry): Promise<void> {
    try {
      await this.prisma.connectorCall.create({
        data: {
          workspaceId: e.workspaceId,
          connectorId: e.connectorId,
          tool: e.tool.slice(0, 200),
          kind: e.kind,
          outcome: e.outcome,
          errorCode: e.errorCode ? e.errorCode.slice(0, 60) : null,
          durationMs: Math.max(0, Math.round(e.durationMs)),
          source: e.source ?? "agent",
        },
      });
    } catch (err) {
      this.logger.warn(`connector call not recorded (${e.connectorId}): ${(err as Error).message}`);
    }
  }
}
