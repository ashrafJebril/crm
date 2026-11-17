import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { CopilotAttachmentsService } from "./copilot-attachments.service";

/**
 * SP-18 (ruling 7): every hour, deletes copilot attachments never sent within
 * 24 h and the attachments of deleted sessions, with their hidden Media rows
 * and stored files.
 */
@Injectable()
export class CopilotAttachmentsSweep {
  private readonly log = new Logger(CopilotAttachmentsSweep.name);

  constructor(private readonly attachments: CopilotAttachmentsService) {}

  @Cron("0 17 * * * *")
  async sweep(now = new Date()): Promise<number> {
    try {
      const n = await this.attachments.sweep(now);
      if (n) this.log.log(`copilot sweep: ${n} attachment(s) deleted`);
      return n;
    } catch (e) {
      this.log.warn(`copilot sweep failed: ${(e as Error)?.name ?? "error"}`);
      return 0;
    }
  }
}
