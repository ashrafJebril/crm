import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * 402 Payment Required — the tenant's Ads wallet can't fund another request.
 * Raised by AdsController when the pre-spend gate (AdsWalletService.hasBalance)
 * refuses BEFORE any Claude call, mapping the domain InsufficientBalanceError.
 * This repo has NO global exception filter — Nest serializes this constructor's
 * body FLAT, as sent:
 *
 *   { code: 'ADS_INSUFFICIENT_BALANCE', message: '...' }
 *
 * The web's error branches read err.code off that flat shape. The Arabic message
 * is what the web surfaces to the business owner.
 */
export class AdsInsufficientBalanceException extends HttpException {
  constructor() {
    super(
      { code: 'ADS_INSUFFICIENT_BALANCE', message: 'رصيدكِ خلص، اشحني للمتابعة' },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}

/**
 * 400 Bad Request — a coming_soon (or otherwise non-active) promptId was sent to
 * POST /ads/chat. The web LOCKS these rows client-side, so this is the
 * server-side backstop and the source of truth. This repo has NO global exception
 * filter — Nest serializes this constructor's body FLAT, as sent:
 * { code: 'PROMPT_NOT_AVAILABLE', message, promptId }.
 *
 * `code` is the contract the web branches on (reading the flat body's `err.code`);
 * `message` is a neutral English fallback — the web renders its own localized
 * copy from the code.
 */
export class AdsPromptNotAvailableException extends HttpException {
  constructor(promptId: string) {
    super(
      { code: 'PROMPT_NOT_AVAILABLE', message: 'This prompt is not available yet', promptId },
      HttpStatus.BAD_REQUEST,
    );
  }
}

/**
 * 503 Service Unavailable — Anthropic stayed overloaded (429 / 529 /
 * overloaded_error) until the request's SHARED retry budget was spent. Raised by
 * AdsController, mapping the domain AdsChatOverloadedError exactly like
 * InsufficientBalanceError → 402. This repo has NO global exception filter — Nest
 * serializes this constructor's body FLAT, as sent:
 *
 *   { code: 'ADS_SERVICE_BUSY', message: '...' }
 *
 * The web branches on status 503 / code ADS_SERVICE_BUSY (reading the flat body's
 * err.code) to show a distinct, non-destructive "busy — try again" state with a
 * retry button; the user-facing copy is the web's localized string, not this
 * message.
 */
export class AdsServiceBusyException extends HttpException {
  constructor() {
    super(
      { code: 'ADS_SERVICE_BUSY', message: 'الخدمة مزدحمة مؤقتاً، جرّب بعد لحظات' },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}
