import { describe, expect, it } from "vitest";
import { makeTx } from "@/lib/tx";
import type { HealthSignal } from "@/lib/types";
import {
  FIELD_ORDER,
  ISSUE_COPY,
  MISSING_VS_UNKNOWN,
  OVERALL_COPY,
  STATE_LABEL,
  checkButtonLabel,
  cooldownLeft,
  issueText,
  laterOf,
  nextCheckFromError,
  overallView,
  signalView,
  templateQualityView,
  templateStatusView,
  templatesView,
  tierView,
  toFullStatus,
  valueView,
} from "./healthModel";

const en = makeTx("en");
const ar = makeTx("ar");
const ARABIC = /[؀-ۿ]/;
const AT = "2026-11-09T08:00:00.000Z";

describe("unknown fields render as unknown", () => {
  const unsupported: HealthSignal = { value: "unknown", checkedAt: null, error: "unsupported" };

  it.each(FIELD_ORDER)("%s: unsupported is a muted Unknown with the provider reason", (field) => {
    const v = signalView(field, unsupported, en);
    expect(v.label).toBe("Unknown");
    expect(v.tone).toBe("neutral");
    expect(v.unknown).toBe(true);
    expect(v.state).toBe("unsupported");
    expect(v.reason).toBe("This provider doesn't report it");
    expect(v.previous).toBeUndefined();
    const a = signalView(field, unsupported, ar);
    expect(a.label).toBe("غير معروف");
    expect(a.reason).toBe("هذا المزوّد لا يوفّر هذه المعلومة");
  });

  it("check_failed with lastKnown is Unknown now, and the old value is only previous", () => {
    const failed: HealthSignal = { value: "unknown", checkedAt: AT, error: "check_failed" };
    const v = signalView("quality", failed, en, { value: "GREEN", checkedAt: "2026-11-08T08:00:00.000Z" });
    expect(v.label).toBe("Unknown");
    expect(v.tone).toBe("neutral");
    expect(v.unknown).toBe(true);
    expect(v.state).toBe("check_failed");
    expect(v.previous).toEqual({ label: "High", at: "2026-11-08T08:00:00.000Z" });
    expect(v.reason).toBe("Couldn't check — last seen High");
    expect(signalView("quality", failed, ar, { value: "GREEN", checkedAt: AT }).reason).toBe("تعذّر الفحص — آخر قيمة عالية");
    // Without a previous value it still says why.
    expect(signalView("quality", failed, en).reason).toBe("Couldn't check");
  });

  it("every unknown state is never good, never blank, never a dash", () => {
    const errors = ["unsupported", "check_failed", "permission_denied", "missing_data", "missing_credentials", null] as const;
    for (const field of FIELD_ORDER) {
      for (const error of errors) {
        for (const tx of [en, ar]) {
          const v = signalView(field, { value: "unknown", checkedAt: AT, error }, tx, { value: "GREEN", checkedAt: AT });
          expect(v.tone, `${field}/${error}`).not.toBe("good");
          expect(v.label.trim()).not.toBe("");
          expect(v.label).not.toMatch(/^[-–—]$/);
          expect(v.unknown).toBe(true);
          expect(v.reason?.trim()).toBeTruthy();
        }
      }
      // A missing signal (no snapshot) is unknown too.
      const none = signalView(field, null, en);
      expect(none.label).toBe("Unknown");
      expect(none.state).toBe("not_checked");
      expect(none.tone).not.toBe("good");
    }
    // Every state has a label in both languages.
    for (const s of Object.values(STATE_LABEL)) {
      expect(s.en.trim()).toBeTruthy();
      expect(s.ar).toMatch(ARABIC);
    }
  });

  it("NOT_RATED is 'Not rated yet', distinct from Unknown", () => {
    const v = signalView("quality", { value: "NOT_RATED", checkedAt: AT, error: null }, en);
    expect(v.label).toBe("Not rated yet");
    expect(v.unknown).toBe(false);
    expect(v.state).toBe("real");
    expect(v.tone).toBe("neutral");
    expect(templateQualityView("NOT_RATED", en).label).toBe("Not rated yet");
    expect(templateQualityView("NOT_RATED", en).unknown).toBe(false);
  });

  it("unknown template status in the sheet is Unknown, missing is 'Not on this number'", () => {
    expect(templateStatusView("unknown", en)).toEqual({ label: "Unknown", tone: "neutral", unknown: true });
    expect(templateStatusView("unknown", ar).label).toBe("غير معروف");
    expect(templateStatusView("missing", en)).toEqual({ label: "Not on this number", tone: "neutral", unknown: false });
    expect(templateStatusView("missing", ar).label).toBe("غير موجود على هذا الرقم");
    expect(templateStatusView(null, en).label).toBe("Unknown");
    // Template quality: null and "unknown" are Unknown, never green.
    for (const q of [null, undefined, "unknown", ""]) {
      const v = templateQualityView(q, en);
      expect(v.label).toBe("Unknown");
      expect(v.tone).toBe("neutral");
    }
    expect(MISSING_VS_UNKNOWN.ar).toMatch(ARABIC);
  });

  it("an unknown templates summary is Unknown, not 'no templates'", () => {
    const v = templatesView({ value: "unknown", checkedAt: AT, error: "check_failed" }, en);
    expect(v.label).toBe("Unknown");
    expect(v.bad).toBeNull();
    expect(v.reason).toBe("Couldn't check");
    const known = templatesView(
      { value: { total: 0, approved: 0, pending: 0, rejected: 0, paused: 0, disabled: 0, lowQuality: 0, truncated: false }, checkedAt: AT, error: null },
      en,
    );
    expect(known.label).toBe("No templates");
    expect(known.bad).toBe(0);
  });

  it("shows the passthrough source on a real value and on a previous value", () => {
    const v = signalView("verified", { value: "VERIFIED", checkedAt: AT, error: null, source: "zernio_passthrough" }, en);
    expect(v.label).toBe("Verified");
    expect(v.source).toBe("Via Zernio (unverified field)");
    expect(signalView("verified", { value: "VERIFIED", checkedAt: AT, error: null }, en).source).toBeUndefined();
    const prev = signalView("verified", { value: "unknown", checkedAt: AT, error: "check_failed" }, ar, {
      value: "VERIFIED",
      checkedAt: AT,
      source: "zernio_passthrough",
    });
    expect(prev.source).toMatch(ARABIC);
  });
});

describe("signal labels", () => {
  it("labels and tones known values per field", () => {
    expect(valueView("quality", "GREEN", en)).toEqual({ label: "High", tone: "good" });
    expect(valueView("quality", "YELLOW", en)).toEqual({ label: "Medium", tone: "warn" });
    expect(valueView("quality", "RED", ar)).toEqual({ label: "منخفضة", tone: "bad" });
    expect(valueView("messaging", "BLOCKED", en).tone).toBe("bad");
    expect(valueView("nameStatus", "DECLINED", en)).toEqual({ label: "Declined", tone: "bad" });
    expect(valueView("nameStatus", "PENDING_REVIEW", en).tone).toBe("warn");
    expect(valueView("verified", "PENDING_SUBMISSION", en).label).toBe("In review");
    expect(valueView("accountReview", "REJECTED", en).tone).toBe("bad");
    expect(valueView("phoneStatus", "CONNECTED", en).tone).toBe("good");
    expect(valueView("phoneStatus", "MESSAGING_LIMIT_REACHED", en).label).toBe("Messaging limited");
    // Open-ended phone status we have no copy for: humanized, neutral, never green.
    expect(valueView("phoneStatus", "SOMETHING_NEW", en)).toEqual({ label: "Something new", tone: "neutral" });
  });
});

describe("tier labels show the daily cap and unlimited", () => {
  it("formats caps, unlimited, not set and digits", () => {
    expect(tierView("TIER_2K", en).label).toBe("2,000 / day");
    expect(tierView("TIER_2K", ar).label).toBe("2,000 / يوم");
    expect(tierView("TIER_100K", en).label).toBe("100,000 / day");
    expect(tierView("TIER_UNLIMITED", en).label).toBe("Unlimited");
    expect(tierView("TIER_UNLIMITED", en).cap).toBe(Number.POSITIVE_INFINITY);
    expect(tierView("TIER_NOT_SET", en).label).toBe("Not set yet");
    expect(tierView("5000", en).label).toBe("5,000 / day");
    expect(tierView("unknown", en).label).toBe("Unknown");
    expect(tierView("TIER_SOMETHING", en).label).toBe("TIER_SOMETHING");
  });

  it("says the limit is shared by the business's numbers (R14)", () => {
    expect(tierView("TIER_1K", en).note).toMatch(/whole business/);
    expect(tierView("TIER_1K", ar).note).toMatch(ARABIC);
    expect(signalView("tier", { value: "TIER_1K", checkedAt: AT, error: null }, en).label).toBe("1,000 / day");
  });
});

describe("overall and issue copy cover every key in both languages", () => {
  it("overall", () => {
    for (const k of Object.keys(OVERALL_COPY) as (keyof typeof OVERALL_COPY)[]) {
      const e = overallView({ overall: k }, en);
      const a = overallView({ overall: k }, ar);
      expect(e.label.trim()).toBeTruthy();
      expect(e.label).not.toMatch(ARABIC);
      expect(a.label).toMatch(ARABIC);
    }
    expect(overallView({ overall: "unknown" }, en).tone).toBe("neutral");
    expect(overallView(null, en)).toEqual({ label: "Not checked yet", tone: "neutral" });
  });

  it("issues, including the dynamic phone status and verification keys", () => {
    const keys = [
      ...Object.keys(ISSUE_COPY),
      "phone_status_flagged",
      "phone_status_restricted",
      "phone_status_banned",
      "phone_status_some_new_state",
      "verification_not_verified",
      "verification_pending_submission",
      "verification_rejected",
    ];
    expect(Object.keys(ISSUE_COPY).sort()).toEqual(
      [
        "quality_red",
        "quality_yellow",
        "messaging_blocked",
        "messaging_limited",
        "name_declined",
        "name_expired",
        "name_pending",
        "account_review_rejected",
        "templates_paused",
        "templates_disabled",
        "templates_low_quality",
        "check_incomplete",
      ].sort(),
    );
    for (const k of keys) {
      const e = issueText(k, en);
      const a = issueText(k, ar);
      expect(e, k).not.toContain(k);
      expect(e, k).not.toMatch(ARABIC);
      expect(a, k).toMatch(ARABIC);
    }
    expect(issueText("phone_status_flagged", en)).toBe("Phone status: Flagged.");
    expect(issueText("verification_not_verified", en)).toBe("Business verification: Not verified.");
  });
});

describe("check button counts down from healthNextCheckAt", () => {
  const now = Date.parse("2026-11-10T10:00:00.000Z");

  it("counts whole seconds and stops at zero", () => {
    expect(cooldownLeft("2026-11-10T10:00:42.000Z", now)).toBe(42);
    expect(cooldownLeft("2026-11-10T10:00:41.200Z", now)).toBe(42);
    expect(cooldownLeft("2026-11-10T10:00:42.000Z", now + 41_000)).toBe(1);
    expect(cooldownLeft("2026-11-10T10:00:42.000Z", now + 42_000)).toBe(0);
    expect(cooldownLeft("2026-11-10T09:59:00.000Z", now)).toBe(0);
    expect(cooldownLeft(null, now)).toBe(0);
    expect(cooldownLeft("garbage", now)).toBe(0);
  });

  it("labels the button while it counts down", () => {
    expect(checkButtonLabel(0, false, en)).toBe("Check now");
    expect(checkButtonLabel(42, false, en)).toBe("Check again in 0:42");
    expect(checkButtonLabel(65, false, ar)).toBe("افحص مجددًا بعد 1:05");
    expect(checkButtonLabel(0, true, en)).toBe("Checking…");
  });

  it("takes the next time from a 429 body: nextAt, else retryAfter", () => {
    expect(nextCheckFromError({ retryAfter: 30, nextAt: "2026-11-10T10:00:42.000Z" }, now)).toBe("2026-11-10T10:00:42.000Z");
    expect(nextCheckFromError({ retryAfter: 30 }, now)).toBe("2026-11-10T10:00:30.000Z");
    expect(nextCheckFromError({ message: "x" }, now)).toBeNull();
    expect(nextCheckFromError(undefined, now)).toBeNull();
    expect(laterOf("2026-11-10T10:00:30.000Z", "2026-11-10T10:00:42.000Z")).toBe("2026-11-10T10:00:42.000Z");
    expect(laterOf(null, "2026-11-10T10:00:42.000Z")).toBe("2026-11-10T10:00:42.000Z");
    expect(laterOf(null, null)).toBeNull();
  });
});

describe("template status badges keep paused and disabled distinct from pending", () => {
  it("toFull passes paused and disabled through", () => {
    expect(toFullStatus("paused")).toBe("paused");
    expect(toFullStatus("disabled")).toBe("disabled");
    expect(toFullStatus("approved")).toBe("approved");
    expect(toFullStatus("local")).toBe("local");
    expect(toFullStatus("failed")).toBe("rejected");
    expect(toFullStatus("submitted")).toBe("pending");
    expect(toFullStatus("something_else")).toBe("pending");
  });

  it("labels each status in both languages, with paused and disabled not pending", () => {
    expect(templateStatusView("paused", en)).toEqual({ label: "Paused", tone: "warn", unknown: false });
    expect(templateStatusView("disabled", en)).toEqual({ label: "Disabled", tone: "bad", unknown: false });
    expect(templateStatusView("PAUSED", en).label).toBe("Paused");
    expect(templateStatusView("pending", en).label).not.toBe(templateStatusView("paused", en).label);
    for (const s of ["approved", "pending", "rejected", "paused", "disabled", "local", "missing", "unknown", "submitted", "failed", "in_appeal"]) {
      expect(templateStatusView(s, ar).label, s).toMatch(ARABIC);
    }
    expect(templateStatusView("approved", en).tone).toBe("good");
  });
});
