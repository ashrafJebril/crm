import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { CopilotAttachmentsService } from "./copilot-attachments.service";
import { CopilotActionsService } from "./copilot-actions.service";

/**
 * SP-18 (ruling 7): every hour, deletes copilot attachments never sent within
 * 24 h and the attachments of deleted sessions, with their hidden Media rows
 * and stored files; and resolves cards stuck EXECUTING (status unknown).
 */
@Injectable()
export class CopilotAttachmentsSweep {
  private readonly log = new Logger(CopilotAttachmentsSweep.name);

  constructor(
    private readonly attachments: CopilotAttachmentsService,
    private readonly actions?: CopilotActionsService,
  ) {}

  @Cron("0 17 * * * *")
  async sweep(now = new Date()): Promise<number> {
    try {
      const n = await this.attachments.sweep(now);
      if (n) this.log.log(`copilot sweep: ${n} attachment(s) deleted`);
      const stale = (await this.actions?.resolveStale(now)) ?? 0;
      if (stale) this.log.warn(`copilot sweep: ${stale} card(s) left executing marked unknown`);
      return n;
    } catch (e) {
      this.log.warn(`copilot sweep failed: ${(e as Error)?.name ?? "error"}`);
      return 0;
    }
  }
}
