import type { NestExpressApplication } from "@nestjs/platform-express";

/**
 * JSON body limit. Select-all bulk actions send up to 10 000 contact ids
 * (~400 KB), past Express's 100 KB default.
 */
export const JSON_BODY_LIMIT = "2mb";

/**
 * Registers the JSON parser with a raised limit. Must run before `app.init()`
 * / `listen()`: Nest then sees a `jsonParser` already mounted and skips its
 * default one. Because the app is created with `rawBody: true`, Nest's
 * `useBodyParser` adds the same `verify` hook as the default parser, so
 * `req.rawBody` stays available to the Meta / Zernio / workflow / Stripe
 * webhook signature checks. The urlencoded parser is left to Nest's default.
 */
export function configureBodyParsers(app: NestExpressApplication): void {
  app.useBodyParser("json", { limit: JSON_BODY_LIMIT });
}
