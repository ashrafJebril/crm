import {
  LIFECYCLE_CATALOG,
  LIFECYCLE_KEYS,
  footerOf,
  keyOfSystemKey,
  systemKeyOf,
  templateDraft,
  templateName,
  templateStepConfig,
} from "./lifecycle-catalog";
import { chooseVariant, pickLanguage } from "./lifecycle-language";
import { formatBookingTexts } from "./lifecycle-text";
import { LIFECYCLE_ERROR_KEYS, lifecycleError } from "./lifecycle-errors";

describe("lifecycle catalog", () => {
  it("lifecycle templates use utility category and fixed placeholders", () => {
    const customer = LIFECYCLE_KEYS.filter((k) => LIFECYCLE_CATALOG[k].audience === "customer");
    expect(customer).toEqual(["booking_confirmed", "booking_reminder", "booking_cancelled", "ticket_opened", "ticket_resolved"]);
    for (const key of customer) {
      for (const lang of ["ar", "en"] as const) {
        const d = templateDraft(key, lang, "Acme Salon");
        expect(d).toMatchObject({ name: `kewy_${key}_${lang}`, lang, category: "UTILITY", footer: "Acme Salon" });
        const nums = [...d.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
        expect({ key, lang, nums }).toEqual({ key, lang, nums: nums.map((_, i) => i + 1) });
        expect(nums.length).toBe(LIFECYCLE_CATALOG[key].variables![lang].length);
        expect(d.bodyExamples).toHaveLength(nums.length);
        expect(d.body.trim()).not.toMatch(/^\{\{\d+\}\}/);
        expect(d.body.trim()).not.toMatch(/\{\{\d+\}\}[.!]?$/);
        if (lang === "ar") expect(d.body).toMatch(/[؀-ۿ]/);
      }
    }
    // Staff keys have no template, just a notification key.
    expect(LIFECYCLE_CATALOG.ticket_opened_staff.messageKey).toBe("lifecycle.ticket_opened");
    expect(LIFECYCLE_CATALOG.new_lead_staff.messageKey).toBe("lifecycle.new_lead");
    expect(() => templateDraft("new_lead_staff", "ar", "x")).toThrow();
  });

  it("names, system keys, footers and step configs", () => {
    expect(templateName("booking_reminder", "en")).toBe("kewy_booking_reminder_en");
    expect(systemKeyOf("ticket_opened")).toBe("lifecycle.ticket_opened");
    expect(keyOfSystemKey("lifecycle.ticket_opened")).toBe("ticket_opened");
    expect(keyOfSystemKey("lifecycle.nope")).toBeNull();
    expect(keyOfSystemKey(null)).toBeNull();
    expect(footerOf("x".repeat(80))).toHaveLength(60);
    const cfg = templateStepConfig("booking_confirmed");
    expect(cfg.variants.ar.name).toBe("kewy_booking_confirmed_ar");
    expect(cfg.variants.en.variables).toEqual([
      "{{trigger.contact.firstName}}",
      "{{trigger.appointment.service}}",
      "{{trigger.appointment.dateTextEn}}",
      "{{trigger.appointment.timeTextEn}}",
    ]);
    expect(LIFECYCLE_CATALOG.booking_reminder.triggerConfig).toEqual({ offsetMinutes: 1440 });
    expect(LIFECYCLE_CATALOG.ticket_opened.triggerConfig).toEqual({ pipelineKind: "support" });
    expect(LIFECYCLE_CATALOG.new_lead_staff.triggerConfig).toEqual({ pipelineKind: "leads" });
  });
});

describe("lifecycle language", () => {
  it("language follows the last inbound script", () => {
    expect(pickLanguage({ lastInboundBody: "مرحبا، أريد حجز موعد", workspaceLang: "en" })).toBe("ar");
    expect(pickLanguage({ lastInboundBody: "Hi, can I book? شكرا", workspaceLang: "en" })).toBe("ar");
    expect(pickLanguage({ lastInboundBody: "Hello there 123", workspaceLang: "ar" })).toBe("en");
    expect(pickLanguage({ lastInboundBody: "👍 123", workspaceLang: "en" })).toBe("en");
    expect(pickLanguage({ lastInboundBody: null, workspaceLang: "ar" })).toBe("ar");
    expect(pickLanguage({ workspaceLang: null })).toBe("ar");
  });

  it("chooses the preferred approved variant, else the other approved one, else none", () => {
    const variants = { ar: { name: "t_ar", language: "ar" }, en: { name: "t_en", language: "en" } };
    expect(chooseVariant(variants, { ar: "approved", en: "approved" }, "ar")?.lang).toBe("ar");
    expect(chooseVariant(variants, { ar: "pending", en: "approved" }, "ar")?.lang).toBe("en");
    expect(chooseVariant(variants, { ar: "approved", en: "paused" }, "en")?.lang).toBe("ar");
    expect(chooseVariant(variants, { ar: "pending", en: "rejected" }, "ar")).toBeNull();
    expect(chooseVariant(variants, {}, "en")).toBeNull();
  });
});

describe("lifecycle text", () => {
  it("formats booking date and time in the workspace timezone with Latin digits", () => {
    // 2027-01-05 07:30Z = Tuesday 10:30 in Riyadh.
    const t = formatBookingTexts("2027-01-05T07:30:00.000Z", "Asia/Riyadh");
    expect(t.timeTextEn).toBe("10:30");
    expect(t.timeTextAr).toBe("10:30");
    expect(t.dateTextEn).toBe("Tuesday 5 January");
    expect(t.dateTextAr).toMatch(/الثلاثاء/);
    expect(t.dateTextAr).toMatch(/5/);
    expect(t.dateTextAr).not.toMatch(/[٠-٩]/);
    expect(formatBookingTexts("2027-01-05T07:30:00.000Z", "Europe/London").timeTextEn).toBe("07:30");
  });
});

describe("lifecycle errors", () => {
  it("every key carries its status and message", () => {
    expect(LIFECYCLE_ERROR_KEYS).toHaveLength(9);
    expect(lifecycleError("lifecycle.no_approved_template").getStatus()).toBe(409);
    expect(lifecycleError("lifecycle.invalid_offset").getStatus()).toBe(400);
    expect(lifecycleError("lifecycle.unknown_key").getStatus()).toBe(404);
    expect(lifecycleError("lifecycle.template_rejected", { language: "ar", reason: "X" }).getResponse()).toEqual({
      statusCode: 409,
      message: "lifecycle.template_rejected",
      language: "ar",
      reason: "X",
    });
    expect(lifecycleError("workflows.system_locked").getStatus()).toBe(409);
  });
});
