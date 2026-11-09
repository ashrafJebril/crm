import { describe, expect, it } from "vitest";
import { ApiError } from "@/api/client";
import { makeTx } from "@/lib/tx";
import {
  CHANNEL_ERROR_COPY,
  STATUS_REASON_COPY,
  channelErrorCopy,
  channelErrorText,
  errorField,
  statusReasonCopy,
} from "./channelErrors";

const ARABIC = /[؀-ۿ]/;

// Every key named in the SP-19 T1–T4 reports (and backend channel-errors.ts).
const ERROR_KEYS = [
  "channels.not_found",
  "channels.limit_reached",
  "channels.disconnected",
  "channels.not_connected",
  "channels.already_connected",
  "channels.connected_elsewhere",
  "channels.default_requires_active",
  "channels.default_conflict",
  "channels.default_required",
  "channels.sender_invalid",
  "channels.encryption_unavailable",
  "channels.transport_unavailable",
  "channels.invalid_config",
  "channels.telegram_invalid_token",
  "channels.telegram_needs_public_url",
  "channels.telegram_send_failed",
  "channels.webhook_forbidden",
  "channels.embedded_signup_unavailable",
  "channels.embedded_signup_not_configured",
  "channels.embedded_signup_failed",
  "channels.meta_token_invalid",
  "channels.meta_no_waba",
  "channels.meta_no_number",
  "channels.landline_wrong_code",
  "channels.landline_rate_limited",
  "channels.landline_cooldown",
  "channels.landline_number_in_use",
  "channels.landline_invalid_input",
  "channels.landline_wrong_state",
  "channels.landline_meta_error",
  "channels.zernio_reauth_required",
  "widget.origin_forbidden",
  "widget.rate_limited",
  "widget.channel_unavailable",
  "widget.visitor_forbidden",
  "widget.invalid_message",
];

const STATUS_REASONS = [
  "disconnected_by_user",
  "zernio_account_missing",
  "integration_removed",
  "merged",
  "meta_register_failed",
  "meta_subscribe_failed",
  "telegram_webhook_failed",
  "telegram_save_failed",
];

// Extras each key can carry, so every branch is exercised.
const EXTRAS: Record<string, Record<string, unknown>[]> = {
  "channels.limit_reached": [{}, { limit: 1, plan: "free" }, { limit: 3, plan: "growth" }],
  "channels.invalid_config": [{}, { field: "allowedOrigins" }, { field: "color" }],
  "channels.telegram_send_failed": [{}, { reason: "no_chat" }, { reason: "Forbidden: bot was blocked by the user" }],
  "channels.embedded_signup_unavailable": [{}, { reason: "channels.embedded_signup_not_configured" }, { reason: "channels.encryption_unavailable" }],
  "channels.embedded_signup_failed": [{ step: "exchange" }, { step: "waba" }, { step: "phone", metaCode: 100 }],
  "channels.landline_cooldown": [{}, { retryAfter: 42, resendAt: "2026-11-09T10:00:00Z" }],
  "channels.landline_invalid_input": [{}, { field: "cc" }, { metaCode: 100 }],
  "channels.landline_meta_error": [{}, { metaCode: 131000 }],
  "widget.rate_limited": [{}, { retryAfter: 30 }],
  "widget.invalid_message": [{ field: "body" }, { field: "name" }],
};

describe("channel error copy completeness", () => {
  it.each(ERROR_KEYS)("%s has English and Arabic text", (key) => {
    expect(CHANNEL_ERROR_COPY[key]).toBeTypeOf("function");
    for (const extra of EXTRAS[key] ?? [{}]) {
      const c = channelErrorCopy(key, extra)!;
      expect(c.en.trim().length).toBeGreaterThan(5);
      expect(ARABIC.test(c.ar)).toBe(true);
      expect(c.en).not.toContain(key);
      expect(c.ar).not.toContain(key);
    }
  });

  it.each(STATUS_REASONS)("statusReason %s has English and Arabic text", (r) => {
    const c = STATUS_REASON_COPY[r]!;
    expect(c.en.trim().length).toBeGreaterThan(5);
    expect(ARABIC.test(c.ar)).toBe(true);
    expect(statusReasonCopy(r)).toEqual(c);
  });

  it("covers exactly the known keys (no silent additions without a test entry)", () => {
    expect(Object.keys(CHANNEL_ERROR_COPY).sort()).toEqual([...ERROR_KEYS].sort());
    expect(Object.keys(STATUS_REASON_COPY).sort()).toEqual([...STATUS_REASONS].sort());
  });
});

describe("channelErrorText", () => {
  const en = makeTx("en");
  const ar = makeTx("ar");

  it("renders limit_reached with limit and plan from the body (m3)", () => {
    const e = new ApiError("channels.limit_reached", 409, undefined, {
      statusCode: 409,
      message: "channels.limit_reached",
      limit: 1,
      plan: "free",
    });
    expect(channelErrorText(e, en)).toBe(
      "Your Free plan allows 1 WhatsApp number. Disconnect one or upgrade your plan to add another.",
    );
    expect(channelErrorText(e, ar)).toContain("1");
    expect(ARABIC.test(channelErrorText(e, ar))).toBe(true);
  });

  it("keeps a legacy English message and never shows a raw unknown key", () => {
    expect(channelErrorText(new ApiError("Unsupported platform: x", 400), en)).toBe("Unsupported platform: x");
    expect(channelErrorText(new ApiError("channels.something_new", 400), en)).toBe("Something went wrong. Try again.");
    expect(channelErrorText(new ApiError("HTTP 500", 500), ar)).toMatch(ARABIC);
  });

  it("reads the field of an invalid_config error", () => {
    const e = new ApiError("channels.invalid_config", 400, undefined, { message: "channels.invalid_config", field: "color" });
    expect(errorField(e)).toBe("color");
    expect(channelErrorText(e, en)).toBe("Check the colour and try again.");
  });
});

describe("statusReasonCopy", () => {
  it("is null without a reason", () => {
    expect(statusReasonCopy(null)).toBeNull();
    expect(statusReasonCopy("")).toBeNull();
  });

  it("localizes Zernio's English health sentences", () => {
    const c = statusReasonCopy("Meta removed access on 2026-09-14. Connect it again.")!;
    expect(c.ar).toContain("2026-09-14");
    expect(ARABIC.test(statusReasonCopy("The sign-in expired. Connect it again.")!.ar)).toBe(true);
  });

  it("keeps unknown reasons in English with a generic Arabic line", () => {
    const c = statusReasonCopy("weird upstream thing")!;
    expect(c.en).toBe("weird upstream thing");
    expect(ARABIC.test(c.ar)).toBe(true);
  });
});
