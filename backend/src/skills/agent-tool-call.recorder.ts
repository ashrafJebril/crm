import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

export interface ToolCallRecord {
  workspaceId: string;
  tool: string;
  skillKey: string | null;
  outcome: "ok" | "error";
  errorCode?: string | null;
  durationMs: number;
}

/** The error key at the start of a tool error message ("tickets.too_many_open …"), else "error". */
export function errorCodeOf(err: unknown): string {
  const msg = err instanceof Error ? err.message : "";
  const m = /^([a-z_]+\.[a-z0-9_]+)\b/.exec(msg);
  return m ? m[1] : "error";
}

/**
 * SP-22 usage log: one AgentToolCall per CRM MCP tool call, fire-and-forget.
 * Never stores arguments or results (they may hold customer data), never
 * blocks or fails the tool.
 */
@Injectable()
export class AgentToolCallRecorder {
  private readonly logger = new Logger(AgentToolCallRecorder.name);

  constructor(private readonly prisma: PrismaService) {}

  record(r: ToolCallRecord): void {
    try {
      void Promise.resolve(
        this.prisma.agentToolCall.create({
          data: {
            workspaceId: r.workspaceId,
            tool: r.tool,
            skillKey: r.skillKey,
            outcome: r.outcome,
            errorCode: r.outcome === "error" ? (r.errorCode ?? "error") : null,
            durationMs: Math.max(0, Math.round(r.durationMs)),
          },
        }),
      ).catch((e: unknown) => this.logger.warn(`tool call log failed: ${(e as Error)?.name ?? "Error"}`));
    } catch (e) {
      this.logger.warn(`tool call log failed: ${(e as Error)?.name ?? "Error"}`);
    }
  }
}
