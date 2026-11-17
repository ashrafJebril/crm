import { Logger } from "@nestjs/common";
import type { EmailMessage, EmailSendResult, EmailSender } from "./email-sender";

export interface ResendConfig {
  apiKey: string;
  from: string;
  /** Default https://api.resend.com; verification points it at a loopback stub. */
  apiBase?: string;
  timeoutMs?: number;
  /** Injectable for specs. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE = "https://api.resend.com";

/**
 * Resend REST (`POST /emails`) over fetch: no SDK, no new dependency.
 * Logs only the kind, the provider status and the message id: never the
 * recipient's link, the body or the API key.
 */
export class ResendEmailSender implements EmailSender {
  readonly enabled = true;
  private readonly logger = new Logger("ResendEmailSender");
  private readonly base: string;

  constructor(private readonly cfg: ResendConfig) {
    this.base = (cfg.apiBase?.trim() || DEFAULT_BASE).replace(/\/+$/, "");
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const doFetch = this.cfg.fetchImpl ?? fetch;
    const res = await doFetch(`${this.base}/emails`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.cfg.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.cfg.from,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
        tags: [{ name: "kind", value: message.kind.replace(/[^A-Za-z0-9_-]/g, "_") }],
      }),
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 10_000),
    });
    if (!res.ok) {
      // The response body may echo the request; it is not logged.
      this.logger.warn(`email ${message.kind} refused by provider (HTTP ${res.status})`);
      throw new Error(`Email provider refused the message (HTTP ${res.status})`);
    }
    const json = (await res.json().catch(() => null)) as { id?: unknown } | null;
    const id = typeof json?.id === "string" ? json.id : null;
    this.logger.log(`email ${message.kind} sent${id ? ` id=${id}` : ""}`);
    return { id };
  }
}
