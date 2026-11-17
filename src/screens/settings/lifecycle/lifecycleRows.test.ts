import { describe, expect, it } from "vitest";
import type { LifecycleRow, TemplateVariant } from "@/lib/types";
import { makeTx } from "@/lib/tx";
import { REMINDER_OFFSET_MAX, REMINDER_OFFSET_MIN, REMINDER_OFFSETS } from "./lifecycleCatalog";
import { BODY_MAX, EDIT_ISSUE_COPY, bodyParts, offersRecipients, offsetChoices, rowView, skippedTotal, syncedText, validateEdit, variantPill } from "./lifecycleRows";

const ARABIC = /[؀-ۿ]/;
const ALL = () => true;

const variant = (lang: "ar" | "en", status: string, rejectionReason: string | null = null): TemplateVariant => ({
  templateId: `tpl-${lang}`,
  name: `kewy_booking_confirmed_${lang}`,
  language: lang,
  status,
  rejectionReason,
  quality: null,
});

const row = (over: Partial<LifecycleRow> = {}): LifecycleRow => ({
  key: "booking_confirmed",
  audience: "customer",
  setUp: true,
  enabled: false,
  workflowId: "wf1",
  recipient: { kind: "customer", userIds: [] },
  offsetMinutes: null,
  variants: { ar: variant("ar", "approved"), en: variant("en", "approved") },
  blockedReason: null,
  lastSentAt: null,
  sent30d: 0,
  skipped30d: {},
  ...over,
});

describe("rejected template shows resubmit and blocks enable", () => {
  it("AR rejected: resubmit, the switch blocked with the reason, the Rejected pill with Meta's reason; approved later: enabled", () => {
    const rejected = row({
      variants: { ar: variant("ar", "rejected", "INVALID_FORMAT"), en: variant("en", "approved") },
      blockedReason: "template_rejected",
    });
    const v = rowView(rejected, ALL);
    expect(v.actions).toContain("resubmit");
    expect(v.switch).toMatchObject({ shown: true, on: false, disabled: true });
    expect(makeTx("en")(...v.switch.reason!)).toMatch(/rejected/i);
    expect(makeTx("ar")(...v.switch.reason!)).toMatch(ARABIC);
    expect(v.statusPill).toBe("rejected");
    expect(v.variants[0]).toMatchObject({ lang: "ar", pill: "rejected" });
    expect(v.variants[0].reason![0]).toContain("INVALID_FORMAT");
    expect(v.variants[0].reason![1]).toContain("INVALID_FORMAT");

    const fixed = rowView(row({ variants: { ar: variant("ar", "approved"), en: variant("en", "approved") }, blockedReason: null }), ALL);
    expect(fixed.switch).toMatchObject({ shown: true, disabled: false, reason: null });
    expect(fixed.actions).not.toContain("resubmit");
    expect(fixed.statusPill).toBe("approved");
  });

  it("a blocked row that is already on can still be turned off", () => {
    const v = rowView(row({ enabled: true, blockedReason: "template_rejected", variants: { ar: variant("ar", "rejected"), en: variant("en", "approved") } }), ALL);
    expect(v.switch).toMatchObject({ on: true, disabled: false });
  });
});

describe("row pill priority follows not set up, paused, in review, rejected, approved", () => {
  const pill = (ar: string | null, en: string | null, setUp = true) =>
    rowView(row({ setUp, variants: { ar: ar ? variant("ar", ar) : null, en: en ? variant("en", en) : null } }), ALL).statusPill;
  it("each step of the ladder", () => {
    expect(pill("approved", "approved", false)).toBe("not_set_up");
    expect(pill("approved", null)).toBe("not_set_up");
    expect(pill("paused", "rejected")).toBe("paused");
    expect(pill("pending", "rejected")).toBe("in_review");
    expect(pill("approved", "submitted")).toBe("in_review");
    expect(pill("rejected", "approved")).toBe("rejected");
    expect(pill("approved", "disabled")).toBe("rejected");
    expect(pill("approved", "approved")).toBe("approved");
  });
  it("variant pills: AR is the main variant", () => {
    expect(variantPill(null)).toBe("not_set_up");
    expect(variantPill(variant("ar", "local"))).toBe("in_review");
    expect(variantPill(variant("ar", "failed"))).toBe("rejected");
    expect(rowView(row(), ALL).variants.map((v) => v.lang)).toEqual(["ar", "en"]);
  });
});

describe("staff rows offer recipients and customer rows do not", () => {
  it("recipient action and choices", () => {
    const staff = row({ key: "ticket_opened_staff", audience: "staff", variants: null, recipient: { kind: "permitted", userIds: [] } });
    expect(offersRecipients(staff)).toBe(true);
    expect(rowView(staff, ALL).actions).toContain("recipient");
    expect(rowView(staff, ALL).statusPill).toBeNull();
    expect(rowView(staff, ALL).actions).not.toContain("sync");
    expect(offersRecipients(row())).toBe(false);
    expect(rowView(row(), ALL).actions).not.toContain("recipient");
  });

  it("permissions gate every action; hidden actions are not offered", () => {
    const only = (p: string[]) => (x: string) => p.includes(x);
    const notSetUp = row({ setUp: false, workflowId: null, variants: null });
    expect(rowView(notSetUp, ALL).actions).toEqual(["setup", "sync"]);
    expect(rowView(notSetUp, only(["workflows.view"])).actions).toEqual([]);
    expect(rowView(notSetUp, ALL).switch.shown).toBe(false);
    const rejected = row({ variants: { ar: variant("ar", "rejected"), en: variant("en", "approved") }, blockedReason: "template_rejected" });
    expect(rowView(rejected, only(["workflows.update"])).actions).toEqual([]);
    expect(rowView(rejected, only(["workflows.update"])).switch.shown).toBe(true);
    expect(rowView(rejected, only(["templates.update"])).actions).toEqual(["edit", "resubmit"]);
    expect(rowView(rejected, only(["templates.update"])).switch.shown).toBe(false);
    expect(rowView(rejected, only(["templates.view"])).actions).toEqual(["sync"]);
  });

  it("skipped totals add every reason", () => {
    expect(skippedTotal(row({ skipped30d: { opted_out: 2, channel_disconnected: 1 } }))).toBe(3);
    expect(skippedTotal(row())).toBe(0);
  });
});

describe("reminder offset choices stay within the server bounds", () => {
  it("presets and a kept custom value", () => {
    for (const o of REMINDER_OFFSETS) {
      expect(o.minutes).toBeGreaterThanOrEqual(REMINDER_OFFSET_MIN);
      expect(o.minutes).toBeLessThanOrEqual(REMINDER_OFFSET_MAX);
    }
    expect(REMINDER_OFFSETS.map((o) => o.minutes)).toEqual([60, 180, 720, 1440, 2880, 10080]);
    expect(offsetChoices(1440)).toEqual([60, 180, 720, 1440, 2880, 10080]);
    expect(offsetChoices(240)).toEqual([60, 180, 240, 720, 1440, 2880, 10080]);
    expect(offsetChoices(20000)).toEqual([60, 180, 720, 1440, 2880, 10080]);
    const reminder = row({ key: "booking_reminder", offsetMinutes: 1440 });
    expect(rowView(reminder, ALL).actions).toContain("offset");
    expect(rowView(row(), ALL).actions).not.toContain("offset");
  });
});

describe("edit drawer refuses placeholder changes and edge placeholders", () => {
  const original = "Hello {{1}}, your booking for {{2}} on {{3}} at {{4}} is confirmed.";
  it("the validator", () => {
    expect(validateEdit(original, "Hi {{1}}! {{2}} on {{3}} at {{4}} is booked.")).toBeNull();
    expect(validateEdit(original, "Hi {{1}}, {{3}} {{2}} at {{4}} ok")).toBeNull(); // reordering keeps the set
    expect(validateEdit(original, "Hi {{1}}, {{2}} on {{3}} is booked.")).toBe("placeholders_changed");
    expect(validateEdit(original, "Hi {{1}} {{1}}, {{2}} on {{3}} at {{4}}.")).toBe("placeholders_changed");
    expect(validateEdit(original, "Hi {{1}}, {{2}} on {{3}} at {{5}}.")).toBe("placeholders_changed");
    expect(validateEdit(original, "{{1}}, your {{2}} on {{3}} at {{4}} is confirmed.")).toBe("edge_placeholder");
    expect(validateEdit(original, "Hello {{1}}, {{2}} on {{3}} at {{4}}")).toBe("edge_placeholder");
    expect(validateEdit(original, "   ")).toBe("empty");
    expect(validateEdit(original, `Hi {{1}} {{2}} {{3}} {{4}} ${"x".repeat(BODY_MAX)}`)).toBe("too_long");
    for (const [en, ar] of Object.values(EDIT_ISSUE_COPY)) {
      expect(en).not.toMatch(ARABIC);
      expect(ar).toMatch(ARABIC);
    }
  });
  it("splits the body into text and placeholders", () => {
    expect(bodyParts("Hi {{1}}, #{{2}}.")).toEqual([{ text: "Hi " }, { placeholder: 1 }, { text: ", #" }, { placeholder: 2 }, { text: "." }]);
  });
});

describe("last synced text", () => {
  it("null after a server restart; otherwise the workspace time with Latin digits", () => {
    expect(syncedText(null, "Asia/Riyadh", "en")).toEqual(["Not synced since restart", "لم تتم المزامنة منذ إعادة التشغيل"]);
    const [en, ar] = syncedText("2026-11-17T09:30:00Z", "Asia/Riyadh", "ar");
    expect(en).toContain("12:30");
    expect(ar).toContain("12:30");
    expect(ar).toMatch(ARABIC);
    expect(ar).not.toMatch(/[٠-٩]/);
  });
});
