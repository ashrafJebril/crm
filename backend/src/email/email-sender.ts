/**
 * SP-26 outbound email port (ruling 1). One implementation per provider,
 * picked by EMAIL_PROVIDER (email.module.ts): `resend` (Resend REST over
 * fetch, no SDK) or `off` (the default). Specs use FakeEmailSender; no spec
 * ever reaches a provider.
 *
 * Callers must never log a message's body or any link in it: invite and
 * reset emails carry single-use tokens.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** A short label for logs and provider tags, e.g. "invite". Never secret. */
  kind: string;
}

export interface EmailSendResult {
  /** The provider's message id, when it returns one. */
  id: string | null;
}

export interface EmailSender {
  /** False when no provider is configured: invites fall back to a copy-link. */
  readonly enabled: boolean;
  /** Sends one message. Throws on a provider failure (the caller decides). */
  send(message: EmailMessage): Promise<EmailSendResult>;
}

/** Nest injection token for the configured EmailSender. */
export const EMAIL_SENDER = Symbol("EMAIL_SENDER");

export type EmailProvider = "resend" | "off";

/** EMAIL_PROVIDER, normalised. Anything unknown is "off". */
export function emailProvider(env: NodeJS.ProcessEnv = process.env): EmailProvider {
  return (env.EMAIL_PROVIDER ?? "").trim().toLowerCase() === "resend" ? "resend" : "off";
}
