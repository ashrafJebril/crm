import { describe, expect, it } from "vitest";
import backendErrors from "../../../backend/src/billing/billing-errors.ts?raw";
import backendCatalog from "../../../backend/src/billing/plan-catalog.ts?raw";
import backendStatus from "../../../backend/src/billing/billing-status.service.ts?raw";
import { ApiError } from "@/api/client";
import { makeTx } from "@/lib/tx";
import type { BillingStatus } from "@/lib/types";
import {
  BANNER_COPY,
  FEATURE_COPY,
  LEDGER_TYPE_COPY,
  METER_COPY,
  METERS,
  bannersFor,
  countdownText,
  fillDays,
  formatJod,
  planCardView,
  planLabel,
  usageText,
} from "./billingModel";
import { BILLING_ERROR_COPY, billingErrorText, planRequiredOf } from "./billingErrors";
import { CONTACT_OWNER, MANAGE_IN_KEWY, planGateView } from "./planGate";

const ARABIC = /[؀-ۿ]/;
const ARABIC_DIGITS = /[٠-٩]/;
const en = makeTx("en");
const ar = makeTx("ar");
const listOf = (src: string, name: string) =>
  [...new RegExp(`${name} = \\[([^\\]]*)\\]`).exec(src)![1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);

const status = (over: Partial<BillingStatus> = {}): BillingStatus => ({
  billedBy: "kewy",
  plan: { key: null, name: "Ultimate" },
  overridden: false,
  features: ["campaigns"],
  payment: { dueSince: null, locksAt: null, locked: false },
  banners: [],
  ...over,
});

describe("billing error copy covers every SP-28 key in both languages", () => {
  it("the 400 keys of billing-errors.ts plus the two 402 messages", () => {
    const block = /const STATUS = \{([\s\S]*?)\}/.exec(backendErrors)![1];
    const keys = [...block.matchAll(/"(billing\.[a-z_]+)"/g)].map((m) => m[1]);
    const messages = [...backendErrors.matchAll(/message: "(billing\.[a-z_]+)"/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThanOrEqual(3);
    expect(messages).toEqual(expect.arrayContaining(["billing.plan_required", "billing.wallet_empty"]));
    expect(Object.keys(BILLING_ERROR_COPY).sort()).toEqual([...new Set([...keys, ...messages])].sort());
    for (const k of Object.keys(BILLING_ERROR_COPY)) {
      const e = new ApiError(k, 400, undefined, { message: k, feature: "campaigns", requiredPlan: "starter", maxDays: 92 });
      expect(billingErrorText(e, en, "en")).not.toMatch(ARABIC);
      expect(billingErrorText(e, en, "en")).not.toBe(k);
      expect(billingErrorText(e, ar, "ar")).toMatch(ARABIC);
      expect(billingErrorText(e, ar, "ar")).not.toMatch(ARABIC_DIGITS);
    }
    expect(billingErrorText(new ApiError("Forbidden", 403), en, "en")).toMatch(/permission/);
  });

  it("every feature, meter and plan the backend names has copy", () => {
    expect(Object.keys(FEATURE_COPY).sort()).toEqual(listOf(backendCatalog, "export const FEATURES").sort());
    expect([...METERS]).toEqual(listOf(backendCatalog, "export const METERS"));
    for (const m of METERS) expect(METER_COPY[m][1]).toMatch(ARABIC);
    for (const k of listOf(backendCatalog, "export const PLAN_KEYS")) expect(planLabel(k, "ar")).toMatch(ARABIC);
    for (const t of ["TOPUP", "MONTHLY_GRANT", "DEBIT", "REFUND", "ADJUST"]) expect(LEDGER_TYPE_COPY[t][1]).toMatch(ARABIC);
  });

  it("banner copy covers every backend banner", () => {
    const banners = [.../export type Banner = ([^;]+);/.exec(backendStatus)![1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(banners.sort()).toEqual(["grace", "low_balance"]);
    const due = BANNER_COPY.payment_due(["1 day", "يوم"]);
    for (const [e, a] of [due, BANNER_COPY.wallet_low, BANNER_COPY.wallet_empty]) {
      expect(e).not.toMatch(ARABIC);
      expect(a).toMatch(ARABIC);
    }
  });
});

describe("feature gated by plan returns 402 PLAN_REQUIRED and UI shows upgrade", () => {
  const e402 = new ApiError("billing.plan_required", 402, "PLAN_REQUIRED", {
    statusCode: 402,
    code: "PLAN_REQUIRED",
    message: "billing.plan_required",
    feature: "campaigns",
    requiredPlan: "starter",
  });

  it("the 402 maps to the not-in-plan state; WALLET_EMPTY and other errors do not", () => {
    expect(planRequiredOf(e402)).toEqual({ feature: "campaigns", requiredPlan: "starter" });
    expect(planRequiredOf(new ApiError("billing.wallet_empty", 402, "WALLET_EMPTY", {}))).toBeNull();
    expect(planRequiredOf(new ApiError("x", 403, "PAYMENT_OVERDUE", {}))).toBeNull();
    expect(planRequiredOf(new Error("x"))).toBeNull();
  });

  it("billing viewers get the Kewy link when configured; everyone else is told to contact the owner", () => {
    const info = planRequiredOf(e402)!;
    const withLink = planGateView(info, { canViewBilling: true, kewyBillingUrl: "https://kewy.example/billing" });
    expect(withLink.action).toEqual({ kind: "kewy", href: "https://kewy.example/billing", label: MANAGE_IN_KEWY });
    expect(withLink.body[0]).toBe("Campaigns is available on the Starter plan and above.");
    expect(withLink.body[1]).toMatch(ARABIC);
    expect(planGateView(info, { canViewBilling: false, kewyBillingUrl: "https://kewy.example/billing" }).action).toEqual({ kind: "contact_owner", label: CONTACT_OWNER });
    expect(planGateView(info, { canViewBilling: true, kewyBillingUrl: undefined }).action.kind).toBe("contact_owner");
    expect(planGateView({ feature: null, requiredPlan: null }, { canViewBilling: false, kewyBillingUrl: undefined }).body[0]).toBe(
      "This feature isn't included in your current plan.",
    );
  });
});

describe("banners from GET /billing/status", () => {
  const now = new Date("2026-11-18T10:00:00Z");
  it("payment due counts down to the lock; reduced payloads never show wallet banners", () => {
    const due = status({ banners: ["grace"], payment: { dueSince: "2026-11-17T09:00:00Z", locksAt: "2026-11-19T09:00:00Z", locked: false } });
    const [b] = bannersFor(due, now);
    expect(b).toMatchObject({ kind: "payment_due", tone: "bad" });
    expect(b.text[0]).toBe("A payment is due. The workspace locks in 23 hours unless it is paid in Kewy.");
    expect(b.text[1]).not.toMatch(ARABIC_DIGITS);
    // Reduced (no billing.view): no wallet, no low_balance.
    expect(bannersFor(status({ banners: ["grace"], payment: due.payment }), now).map((x) => x.kind)).toEqual(["payment_due"]);
    expect(bannersFor(status({ banners: ["low_balance"] }), now)).toEqual([]);
  });

  it("wallet low vs empty, and nothing when paid up", () => {
    expect(bannersFor(status({ banners: ["low_balance"], wallet: { balanceJod: "0.2000", lowBalance: true } }), now)[0].kind).toBe("wallet_low");
    expect(bannersFor(status({ banners: ["low_balance"], wallet: { balanceJod: "0.0000", lowBalance: true } }), now)[0].kind).toBe("wallet_empty");
    expect(bannersFor(status(), now)).toEqual([]);
    expect(bannersFor(null, now)).toEqual([]);
  });

  it("countdown words in both languages", () => {
    expect(countdownText("2026-11-20T12:00:00Z", now)).toEqual(["2 days 2 hours", "يومين وساعتين"]);
    expect(countdownText("2026-11-18T10:30:00Z", now)).toEqual(["less than an hour", "أقل من ساعة"]);
    expect(countdownText("2026-11-18T09:00:00Z", now)).toEqual(["now", "الآن"]);
  });
});

describe("money, placeholders and usage", () => {
  it("money formats JOD with three decimals and Latin digits in Arabic", () => {
    expect(formatJod("12.3456", "en")).toMatch(/12\.346/);
    expect(formatJod("12.3456", "en")).toMatch(/JOD|JD/);
    const a = formatJod("1234.5", "ar");
    expect(a).toMatch(/1,?234\.500|1٬234٫500|1234\.500/);
    expect(a).not.toMatch(ARABIC_DIGITS);
    expect(formatJod("abc", "en")).toMatch(/0\.000/);
  });

  it("placeholders stay hidden until set (R3)", () => {
    const v = planCardView({ key: "free", rank: 0, limits: { whatsappNumbers: 1 }, features: [] });
    expect(v).toEqual({ key: "free", monthlyJod: null, annualJod: null, allowances: [], whatsappNumbers: 1, seats: null });
    const set = planCardView({
      key: "pro",
      rank: 3,
      priceJod: { monthly: 49, annual: 490 },
      allowances: { ai_reply: 5000 },
      limits: { whatsappNumbers: 10, seats: 20 },
      features: [],
    });
    expect(set).toMatchObject({ monthlyJod: 49, annualJod: 490, allowances: [{ meter: "ai_reply", value: 5000 }], seats: 20 });
  });

  it("usage against an allowance only when one is set; days are zero-filled", () => {
    expect(usageText(1200, null, "en")).toBe("1,200");
    expect(usageText(120, 500, "en")).toBe("120 of 500");
    expect(usageText(120, 500, "ar")).toBe("120 من 500");
    expect(fillDays([{ day: "2026-11-02", qty: 3 }], "2026-11-01", "2026-11-03")).toEqual([
      { day: "2026-11-01", qty: 0 },
      { day: "2026-11-02", qty: 3 },
      { day: "2026-11-03", qty: 0 },
    ]);
  });
});
