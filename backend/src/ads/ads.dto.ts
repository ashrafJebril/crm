import { IsIn, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/**
 * Request DTOs for the Ads Assistant endpoints.
 *
 * hjz validated request bodies with zod (`@hjz/contracts` + `ZodValidationPipe`
 * per handler). The CRM runs ONE global
 * `ValidationPipe({ whitelist, transform, forbidNonWhitelisted })`, so every
 * accepted body field MUST be declared here as a class-validator property —
 * anything else 400s before the handler runs. The zod schemas in `ads.types.ts`
 * stay the source of truth for the response/domain shapes; only the REQUEST
 * validator changes, and the accepted shape is unchanged from hjz except where
 * noted:
 *  - `sessionId` is a cuid (CRM ids are cuids) — deliberately NO uuid validator.
 *  - `amountJod` crosses the wire as a JSON number (hjz's schema took a decimal
 *    STRING, but it had no caller); the controller converts it back to a
 *    2-decimal string for PaymentGatewayPort, which still takes a string.
 *  - Cross-field / env-dependent rules (exactly-one-of, the top-up floor, the
 *    ≤2-decimals and absolute-max checks) cannot be expressed by
 *    class-validator, so they run in the controller — see AdsController.
 */
export class PostAdsChatDto {
  /** Omit to start a new session; otherwise append to it. cuid, not uuid. */
  @IsOptional() @IsString() sessionId?: string;

  /**
   * 2000 chars mirrors `postAdsChatRequestSchema`. Blank/whitespace is NOT
   * rejected here: the exactly-one-of check in the controller treats a blank
   * message as absent, exactly like the zod `.refine()` it replaces
   * (`v.message?.trim()`).
   */
  @IsOptional() @IsString() @MaxLength(2000) message?: string;

  /** Resolved server-side from the catalog in `locale` (unknown → 400). */
  @IsOptional() @IsString() promptId?: string;

  /** zod applied `.default('ar')`; class-validator cannot default, so the
   *  controller substitutes 'ar' when absent. */
  @IsOptional() @IsIn(['ar', 'en']) locale?: 'ar' | 'en';
}

export class PostAdsTopupDto {
  /**
   * `@Min` is a structural positivity guard only. The real BUSINESS floor is
   * env-configurable (`ADS_MIN_TOPUP_JOD`, default 5) and lives in the
   * controller together with the ≤2-decimals and absolute-max rules, so all
   * three produce explicit messages from ONE place — a floor duplicated here
   * would silently CAP the operator's setting.
   */
  @IsNumber() @Min(0.01) amountJod!: number;
}
