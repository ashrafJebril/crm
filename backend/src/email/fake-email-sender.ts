import type { EmailMessage, EmailSendResult, EmailSender } from "./email-sender";

/** In-memory sender for specs (never a runtime provider). `fail` makes the
 *  next sends throw, like a provider outage. */
export class FakeEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  fail: Error | null = null;

  constructor(readonly enabled = true) {}

  async send(message: EmailMessage): Promise<EmailSendResult> {
    if (this.fail) throw this.fail;
    this.sent.push(message);
    return { id: `fake_${this.sent.length}` };
  }

  /** The last message sent to `to` (case-insensitive), if any. */
  lastTo(to: string): EmailMessage | undefined {
    const want = to.toLowerCase();
    return [...this.sent].reverse().find((m) => m.to.toLowerCase() === want);
  }
}
