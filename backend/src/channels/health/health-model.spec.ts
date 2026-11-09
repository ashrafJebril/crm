import { ZernioBudget } from "../../campaigns/sending/zernio-budget";
import { toChannelDto } from "../channel-dto";
import {
  computeIssues,
  computeOverall,
  mergeHealth,
  normalizeQuality,
  normalizeTier,
  publicHealth,
  SIGNAL_NAMES,
  summarizeTemplates,
  tierCap,
  toSignal,
  UNKNOWN,
  type ChannelHealth,
  type FieldName,
  type RawHealthRead,
  type RawTemplate,
  type Signal,
} from "./health-model";
import { readMetaHealth } from "./meta-health.reader";
import { readZernioHealth } from "./zernio-health.reader";

const NOW = new Date("2026-11-09T10:00:00.000Z");
const LATER = new Date("2026-11-10T10:00:00.000Z");

/** A budget whose buckets never wait. */
const freeBudget = () =>
  new ZernioBudget({ ZERNIO_CAMPAIGN_RPM: "100000", ZERNIO_HEALTH_RPM: "100000" }, { now: () => 0, sleep: async () => undefined });

const FULL_ZERNIO_INFO = {
  phone: {
    quality_rating: "GREEN",
    messaging_limit_tier: "TIER_1K",
    name_status: "APPROVED",
    status: "CONNECTED",
    health_status: { can_send_message: "AVAILABLE" },
  },
  waba: { id: "w1" },
};

const zernioFake = (info: unknown = FULL_ZERNIO_INFO, templates: unknown[] = []) => ({
  whatsappNumberInfo: jest.fn(async () => info as never),
  whatsappTemplates: jest.fn(async () => templates as never),
});

/** A Meta Graph double answering one field per call. */
const META_VALUES: Record<string, unknown> = {
  quality_rating: "GREEN",
  whatsapp_business_manager_messaging_limit: "TIER_10K",
  name_status: "APPROVED",
  code_verification_status: "VERIFIED",
  health_status: { can_send_message: "AVAILABLE", entities: [] },
  status: "CONNECTED",
  business_verification_status: "VERIFIED",
  account_review_status: "APPROVED",
};
const graphFake = (over: Record<string, unknown | Error> = {}) => ({
  getField: jest.fn(async (_node: string, field: string) => {
    const v = field in over ? over[field] : META_VALUES[field];
    if (v instanceof Error) throw v;
    return v;
  }),
  listTemplates: jest.fn(async () => ({
    data: [{ id: "t1", name: "promo", language: "en", status: "APPROVED", category: "MARKETING", quality_score: { score: "GREEN" } }],
    after: null,
  })),
});

const sig = (value: string, error: Signal["error"] = null): Signal => ({ value, checkedAt: NOW.toISOString(), error });

describe("providers that cannot supply a field return unknown", () => {
  it("a Zernio read with every documented field set: known values, and unsupported for verified, codeVerification, accountReview", async () => {
    const read = await readZernioHealth(zernioFake(), freeBudget(), "acc1");
    const h = mergeHealth(null, read, { now: NOW, trigger: "manual" });
    expect(h.quality).toEqual(sig("GREEN"));
    expect(h.tier).toEqual(sig("TIER_1K"));
    expect(h.nameStatus).toEqual(sig("APPROVED"));
    expect(h.messaging).toEqual(sig("AVAILABLE"));
    expect(h.phoneStatus).toEqual(sig("CONNECTED"));
    for (const f of ["verified", "codeVerification", "accountReview"] as const) {
      expect({ f, s: h[f] }).toEqual({ f, s: { value: "unknown", checkedAt: null, error: "unsupported" } });
    }
    // Unsupported fields are not "incomplete", and never defaulted.
    expect(h.issues).not.toContain("check_incomplete");
    expect(h.overall).toBe("healthy");
  });

  it("an undocumented Zernio passthrough is used only when present, and marked with its source (R1)", async () => {
    const info = {
      phone: { ...FULL_ZERNIO_INFO.phone, code_verification_status: "VERIFIED" },
      waba: { business_verification_status: "VERIFIED", account_review_status: "nonsense value" },
    };
    const h = mergeHealth(null, await readZernioHealth(zernioFake(info), freeBudget(), "acc1"), { now: NOW, trigger: "manual" });
    expect(h.codeVerification).toEqual({ ...sig("VERIFIED"), source: "zernio_passthrough" });
    expect(h.verified).toEqual({ ...sig("VERIFIED"), source: "zernio_passthrough" });
    expect(h.accountReview).toEqual({ value: "unknown", checkedAt: null, error: "unsupported" });
  });

  it("Zernio template quality is unknown when quality_score is absent and GREEN when present", async () => {
    const templates = [
      { id: "1", name: "a", language: "en", status: "APPROVED", category: "UTILITY" },
      { id: "2", name: "b", language: "ar", status: "APPROVED", category: "UTILITY", quality_score: { score: "GREEN" } },
    ];
    const h = mergeHealth(null, await readZernioHealth(zernioFake(undefined, templates), freeBudget(), "acc1"), {
      now: NOW,
      trigger: "manual",
    });
    const t = h.templates.value;
    if (t === UNKNOWN) throw new Error("templates unknown");
    expect(t.items.map((i) => i.quality)).toEqual(["unknown", "GREEN"]);
    expect(t.lowQuality).toBe(0);
  });

  it("Zernio quality_rating UNKNOWN gives unknown; Meta NA gives NOT_RATED", async () => {
    const info = { phone: { ...FULL_ZERNIO_INFO.phone, quality_rating: "UNKNOWN" } };
    const z = mergeHealth(null, await readZernioHealth(zernioFake(info), freeBudget(), "acc1"), { now: NOW, trigger: "manual" });
    expect(z.quality.value).toBe("unknown");
    expect(z.quality.error).toBe("missing_data");
    const m = mergeHealth(null, await readMetaHealth(graphFake({ quality_rating: "NA" }), { accessToken: "tok", externalId: "pn1" }, "waba1"), {
      now: NOW,
      trigger: "manual",
    });
    expect(m.quality).toEqual(sig("NOT_RATED"));
    expect(normalizeQuality("UNKNOWN")).toBeNull();
    expect(normalizeQuality("na")).toBe("NOT_RATED");
  });

  it("a can_send_message outside the Meta enum gives unknown with missing_data", async () => {
    const info = { phone: { ...FULL_ZERNIO_INFO.phone, health_status: { can_send_message: "MAYBE" } } };
    const h = mergeHealth(null, await readZernioHealth(zernioFake(info), freeBudget(), "acc1"), { now: NOW, trigger: "manual" });
    expect(h.messaging).toEqual(sig("unknown", "missing_data"));
    expect(h.issues).toContain("check_incomplete");
    // Absent from a documented object: missing_data too, never AVAILABLE.
    const none = { phone: { ...FULL_ZERNIO_INFO.phone, health_status: undefined } };
    const h2 = mergeHealth(null, await readZernioHealth(zernioFake(none), freeBudget(), "acc1"), { now: NOW, trigger: "manual" });
    expect(h2.messaging).toEqual(sig("unknown", "missing_data"));
    expect(h2.overall).toBe("unknown");
  });

  it("a Meta read with every field gives no unknowns", async () => {
    const h = mergeHealth(null, await readMetaHealth(graphFake(), { accessToken: "tok", externalId: "pn1" }, "waba1"), {
      now: NOW,
      trigger: "manual",
    });
    for (const f of SIGNAL_NAMES) expect({ f, v: h[f].value === UNKNOWN }).toEqual({ f, v: false });
    expect(h.templates.value).not.toBe(UNKNOWN);
    expect(h.issues).toEqual([]);
    expect(h.overall).toBe("healthy");
    expect(h.provider).toBe("meta");
  });

  it("unknown stays unknown and is never defaulted (every field, every error)", () => {
    for (const f of SIGNAL_NAMES) {
      expect(toSignal(undefined, f, { provider: "zernio", now: NOW })).toEqual({ value: "unknown", checkedAt: null, error: "unsupported" });
      for (const err of ["check_failed", "permission_denied", "missing_credentials"] as const) {
        expect(toSignal({ error: err }, f, { provider: "meta", now: NOW })).toEqual(sig("unknown", err));
      }
      for (const raw of [null, undefined, "", "   ", 42.5, {}, [], "not a value!"]) {
        const s = toSignal({ value: raw }, f, { provider: "meta", now: NOW });
        if (f === "tier" && raw === 42.5) continue;
        expect({ f, raw, value: s.value }).toEqual({ f, raw, value: "unknown" });
      }
    }
    // An all-unknown health is overall unknown, never healthy.
    const read: RawHealthRead = { provider: "meta", fields: {}, templates: { error: "check_failed" } };
    const h = mergeHealth(null, read, { now: NOW, trigger: "sweep" });
    expect(h.overall).toBe("unknown");
    expect(h.issues).toEqual(["check_incomplete"]);
  });

  it("open-ended fields keep a new provider value verbatim (phone status, tier)", () => {
    expect(toSignal({ value: "PENDING_DELETION" }, "phoneStatus", { provider: "meta", now: NOW }).value).toBe("PENDING_DELETION");
    expect(normalizeTier("TIER_NOT_SET")).toBe("TIER_NOT_SET");
    expect(normalizeTier(5000)).toBe("5000");
    expect(normalizeTier("0")).toBeNull();
    expect(tierCap("TIER_2K")).toBe(2000);
    expect(tierCap("TIER_UNLIMITED")).toBe(Number.POSITIVE_INFINITY);
    expect(tierCap("TIER_NOT_SET")).toBeNull();
    expect(tierCap("5000")).toBe(5000);
  });
});

describe("a failed read keeps the last value as previous only", () => {
  it("quality throws: unknown with check_failed, lastKnown holds GREEN, overall ignores it", async () => {
    const first = mergeHealth(null, await readMetaHealth(graphFake(), { accessToken: "tok", externalId: "pn1" }, "waba1"), {
      now: NOW,
      trigger: "manual",
    });
    expect(first.quality.value).toBe("GREEN");
    const failed = await readMetaHealth(
      graphFake({ quality_rating: new Error("boom"), health_status: new Error("boom") }),
      { accessToken: "tok", externalId: "pn1" },
      "waba1",
    );
    const h = mergeHealth(first, failed, { now: LATER, trigger: "sweep" });
    expect(h.quality).toEqual({ value: "unknown", checkedAt: LATER.toISOString(), error: "check_failed" });
    expect(h.lastKnown.quality).toEqual({ value: "GREEN", checkedAt: NOW.toISOString() });
    expect(h.lastKnown.messaging).toEqual({ value: "AVAILABLE", checkedAt: NOW.toISOString() });
    // The old value is not counted: quality and messaging unknown → overall unknown.
    expect(h.overall).toBe("unknown");
    expect(h.issues).toEqual(["check_incomplete"]);
    // A second failure keeps the same last-known value and time.
    const again = mergeHealth(h, failed, { now: new Date("2026-11-11T10:00:00.000Z"), trigger: "sweep" });
    expect(again.lastKnown.quality).toEqual({ value: "GREEN", checkedAt: NOW.toISOString() });
    // A later success clears it.
    const ok = mergeHealth(again, await readMetaHealth(graphFake(), { accessToken: "tok", externalId: "pn1" }, "waba1"), {
      now: LATER,
      trigger: "manual",
    });
    expect(ok.lastKnown.quality).toBeUndefined();
    expect(ok.quality.value).toBe("GREEN");
  });

  it("carries alerts unchanged (evaluateAlerts owns them)", () => {
    const prev = { alerts: { baselineAt: NOW.toISOString(), levels: { quality: 1 } } } as unknown as ChannelHealth;
    const h = mergeHealth(prev, { provider: "zernio", fields: {}, templates: { error: "check_failed" } }, { now: LATER, trigger: "manual" });
    expect(h.alerts).toEqual(prev.alerts);
  });
});

describe("template summary counts buckets, caps at 500 and flags truncation", () => {
  const t = (status: string, score?: string, i = 0): RawTemplate => ({
    id: `t${i}`,
    name: `n${i}`,
    language: "en",
    status,
    category: "UTILITY",
    ...(score !== undefined ? { qualityScore: score } : {}),
  });

  it("counts each bucket; DISABLED is disabled, not rejected; YELLOW and RED are lowQuality", () => {
    const s = summarizeTemplates([
      t("APPROVED", "GREEN"),
      t("APPROVED", "YELLOW"),
      t("PAUSED", "RED"),
      t("DISABLED"),
      t("REJECTED"),
      t("PENDING"),
      t("IN_APPEAL"),
      t("APPROVED", "UNKNOWN"),
      t("SOMETHING_NEW"),
    ]);
    expect(s).toMatchObject({ total: 9, approved: 3, pending: 2, rejected: 1, paused: 1, disabled: 1, lowQuality: 2, truncated: false });
    expect(s.items.map((i) => i.quality)).toEqual(["GREEN", "YELLOW", "RED", "unknown", "unknown", "unknown", "unknown", "NOT_RATED", "unknown"]);
    expect(s.items[8].status).toBe("SOMETHING_NEW");
  });

  it("caps items at 500 and flags truncation; counts cover every template read", () => {
    const many = Array.from({ length: 501 }, (_, i) => t("APPROVED", "GREEN", i));
    const s = summarizeTemplates(many, { max: 500 });
    expect(s.items).toHaveLength(500);
    expect(s.total).toBe(501);
    expect(s.approved).toBe(501);
    expect(s.truncated).toBe(true);
    expect(summarizeTemplates([t("APPROVED")], { truncated: true }).truncated).toBe(true);
    expect(summarizeTemplates(many.slice(0, 500)).truncated).toBe(false);
  });
});

describe("overall and issues follow the severity rules", () => {
  const base = (): Pick<ChannelHealth, FieldName | "templates"> => ({
    quality: sig("GREEN"),
    tier: sig("TIER_1K"),
    nameStatus: sig("APPROVED"),
    verified: sig("VERIFIED"),
    codeVerification: sig("VERIFIED"),
    messaging: sig("AVAILABLE"),
    phoneStatus: sig("CONNECTED"),
    accountReview: sig("APPROVED"),
    templates: {
      value: { total: 0, approved: 0, pending: 0, rejected: 0, paused: 0, disabled: 0, lowQuality: 0, items: [], truncated: false },
      checkedAt: NOW.toISOString(),
      error: null,
    },
  });
  const unsupported: Signal = { value: "unknown", checkedAt: null, error: "unsupported" };
  type Case = [string, (h: ReturnType<typeof base>) => void, string[], string];
  const cases: Case[] = [
    ["all good", () => undefined, [], "healthy"],
    ["quality RED", (h) => (h.quality = sig("RED")), ["quality_red"], "critical"],
    ["quality YELLOW", (h) => (h.quality = sig("YELLOW")), ["quality_yellow"], "attention"],
    ["quality NOT_RATED", (h) => (h.quality = sig("NOT_RATED")), [], "healthy"],
    ["messaging BLOCKED", (h) => (h.messaging = sig("BLOCKED")), ["messaging_blocked"], "critical"],
    ["messaging LIMITED", (h) => (h.messaging = sig("LIMITED")), ["messaging_limited"], "attention"],
    ["phone FLAGGED", (h) => (h.phoneStatus = sig("FLAGGED")), ["phone_status_flagged"], "attention"],
    ["phone RESTRICTED", (h) => (h.phoneStatus = sig("RESTRICTED")), ["phone_status_restricted"], "critical"],
    ["phone BANNED", (h) => (h.phoneStatus = sig("BANNED")), ["phone_status_banned"], "critical"],
    ["phone DISCONNECTED", (h) => (h.phoneStatus = sig("DISCONNECTED")), ["phone_status_disconnected"], "critical"],
    ["name DECLINED", (h) => (h.nameStatus = sig("DECLINED")), ["name_declined"], "critical"],
    ["name EXPIRED", (h) => (h.nameStatus = sig("EXPIRED")), ["name_expired"], "attention"],
    ["name PENDING_REVIEW", (h) => (h.nameStatus = sig("PENDING_REVIEW")), ["name_pending"], "attention"],
    ["review REJECTED", (h) => (h.accountReview = sig("REJECTED")), ["account_review_rejected"], "critical"],
    ["verification PENDING", (h) => (h.verified = sig("PENDING")), ["verification_pending"], "attention"],
    ["verification NOT_VERIFIED", (h) => (h.verified = sig("NOT_VERIFIED")), ["verification_not_verified"], "attention"],
    [
      "templates paused, disabled and low quality",
      (h) => {
        const v = h.templates.value as Exclude<typeof h.templates.value, "unknown">;
        Object.assign(v, { paused: 1, disabled: 2, lowQuality: 1 });
      },
      ["templates_paused", "templates_disabled", "templates_low_quality"],
      "attention",
    ],
    ["a failed field only", (h) => (h.tier = sig("unknown", "check_failed")), ["check_incomplete"], "healthy"],
    ["unsupported fields are complete", (h) => Object.assign(h, { verified: unsupported, accountReview: unsupported, codeVerification: unsupported }), [], "healthy"],
    ["quality unknown", (h) => (h.quality = sig("unknown", "check_failed")), ["check_incomplete"], "unknown"],
    ["messaging unsupported", (h) => (h.messaging = unsupported), [], "unknown"],
    [
      "critical beats attention, incomplete listed last",
      (h) => {
        h.quality = sig("YELLOW");
        h.messaging = sig("BLOCKED");
        h.tier = sig("unknown", "permission_denied");
      },
      ["quality_yellow", "messaging_blocked", "check_incomplete"],
      "critical",
    ],
    ["templates unknown", (h) => (h.templates = { value: "unknown", checkedAt: NOW.toISOString(), error: "check_failed" }), ["check_incomplete"], "healthy"],
  ];

  it.each(cases)("%s", (_name, mutate, issues, overall) => {
    const h = base();
    mutate(h);
    expect(computeIssues(h)).toEqual(issues);
    expect(computeOverall(h)).toBe(overall);
  });
});

describe("channel dto exposes public health without alerts or template items", () => {
  it("drops alerts and items, keeps counts; adds healthCheckedAt and healthNextCheckAt", async () => {
    const h = mergeHealth(null, await readMetaHealth(graphFake(), { accessToken: "tok", externalId: "pn1" }, "waba1"), {
      now: NOW,
      trigger: "manual",
    });
    h.alerts = { baselineAt: NOW.toISOString(), levels: { quality: 0 } };
    const row = {
      id: "c1",
      kind: "whatsapp",
      provider: "meta",
      externalId: "pn1",
      displayName: "Main",
      phoneNumber: "+1555",
      status: "active",
      statusReason: null,
      isDefault: true,
      lastInboundAt: null,
      createdAt: NOW,
      config: { wabaId: "waba1" },
      health: JSON.parse(JSON.stringify(h)),
      healthCheckedAt: NOW,
      healthAttemptedAt: NOW,
      secretsEnc: "SECRET",
    };
    const dto = toChannelDto(row, {}, new Date(NOW.getTime() + 10_000));
    expect(dto.health).not.toBeNull();
    expect(dto.health).not.toHaveProperty("alerts");
    expect(dto.health!.templates.value).toMatchObject({ total: 1, approved: 1 });
    expect(dto.health!.templates.value).not.toHaveProperty("items");
    expect(dto.health!.quality.value).toBe("GREEN");
    expect(dto.healthCheckedAt).toBe(NOW.toISOString());
    expect(dto.healthNextCheckAt).toBe(new Date(NOW.getTime() + 60_000).toISOString());
    expect(JSON.stringify(dto)).not.toContain("SECRET");
    expect(JSON.stringify(dto)).not.toContain("promo");
    // After the cooldown, no next-check time.
    expect(toChannelDto(row, {}, new Date(NOW.getTime() + 60_000)).healthNextCheckAt).toBeNull();
  });

  it("no health yet (or a malformed one) is null", () => {
    const row = {
      id: "c1",
      kind: "whatsapp",
      provider: "zernio",
      externalId: "a",
      displayName: "x",
      phoneNumber: null,
      status: "active",
      statusReason: null,
      isDefault: false,
      lastInboundAt: null,
      createdAt: NOW,
    };
    expect(toChannelDto(row)).toMatchObject({ health: null, healthCheckedAt: null, healthNextCheckAt: null });
    expect(toChannelDto({ ...row, health: { v: 2 } }).health).toBeNull();
    expect(publicHealth({ v: 1, templates: { value: "unknown", checkedAt: null, error: "check_failed" } })?.templates.value).toBe("unknown");
  });
});
