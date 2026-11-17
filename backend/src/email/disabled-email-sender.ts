import { ServiceUnavailableException } from "@nestjs/common";
import type { EmailMessage, EmailSendResult, EmailSender } from "./email-sender";

/** EMAIL_PROVIDER=off (the default): nothing is sent. Invite flows check
 *  `enabled` first and return a copy-link instead; anything that still calls
 *  `send` gets 503 `email.not_configured`. */
export class DisabledEmailSender implements EmailSender {
  readonly enabled = false;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async send(_message: EmailMessage): Promise<EmailSendResult> {
    throw new ServiceUnavailableException({ statusCode: 503, message: "email.not_configured" });
  }
}
