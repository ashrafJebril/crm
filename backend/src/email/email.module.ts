import { Global, Logger, Module } from "@nestjs/common";
import { DisabledEmailSender } from "./disabled-email-sender";
import { EMAIL_SENDER, emailProvider, type EmailSender } from "./email-sender";
import { ResendEmailSender } from "./resend-email-sender";

/**
 * The configured sender (ruling 1). `resend` needs RESEND_API_KEY and
 * EMAIL_FROM; without them the app falls back to "off" with a warning rather
 * than failing to boot. Secrets are never logged.
 */
export function createEmailSender(env: NodeJS.ProcessEnv = process.env, logger = new Logger("EmailModule")): EmailSender {
  if (emailProvider(env) !== "resend") return new DisabledEmailSender();
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.EMAIL_FROM?.trim();
  if (!apiKey || !from) {
    logger.warn("EMAIL_PROVIDER=resend but RESEND_API_KEY or EMAIL_FROM is not set; email is off");
    return new DisabledEmailSender();
  }
  return new ResendEmailSender({ apiKey, from, apiBase: env.RESEND_API_BASE });
}

@Global()
@Module({
  providers: [{ provide: EMAIL_SENDER, useFactory: () => createEmailSender() }],
  exports: [EMAIL_SENDER],
})
export class EmailModule {}
