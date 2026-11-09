import { alertLevel, evaluateAlerts, UNLIMITED_LEVEL } from "./health-alerts";
import { mergeHealth, type ChannelHealth, type FieldName, type HealthAlerts, type RawField, type RawHealthRead } from "./health-model";

const T0 = new Date("2026-11-09T00:00:00.000Z");
const at = (i: number) => new Date(T0.getTime() + i * 3_600_000);

type State = Partial<Record<FieldName, string | null>> & { templatesBad?: number | null };

/** A health snapshot with the given values (null = a failed read). */
function health(state: State, i: number): ChannelHealth {
  const fields: RawHealthRead["fields"] = {};
  const values: Record<string, string> = {
    quality: "GREEN",
    tier: "TIER_10K",
    nameStatus: "APPROVED",
    messaging: "AVAILABLE",
    phoneStatus: "CONNECTED",
    accountReview: "APPROVED",
    verified: "VERIFIED",
    codeVerification: "VERIFIED",
  };
  for (const [k, v] of Object.entries(values)) {
    const s = k in state ? state[k as FieldName] : v;
    fields[k as FieldName] = (s === null ? { error: "check_failed" } : { value: s }) as RawField;
  }
  const bad = state.templatesBad;
  const templates: RawHealthRead["templates"] =
    bad === null
      ? { error: "check_failed" }
      : {
          items: Array.from({ length: bad ?? 0 }, (_, n) => ({ id: `t${n}`, name: `t${n}`, language: "en", status: "PAUSED", category: null })),
          truncated: false,
        };
  return mergeHealth(null, { provider: "meta", fields, templates }, { now: at(i), trigger: "sweep" });
}

describe("evaluateAlerts table", () => {
  // Each step: the state read, then the changes expected (signal:to).
  const steps: Array<[string, State, string[]]> = [
    ["baseline is silent (even when bad)", { quality: "GREEN", tier: "TIER_10K", templatesBad: 0 }, []],
    ["GREEN→YELLOW is one change", { quality: "YELLOW" }, ["quality:YELLOW"]],
    ["YELLOW→YELLOW none", { quality: "YELLOW" }, []],
    ["YELLOW→RED one", { quality: "RED" }, ["quality:RED"]],
    ["RED→unknown none", { quality: null }, []],
    ["unknown→RED none (unknown did not re-arm)", { quality: "RED" }, []],
    ["RED→GREEN none, re-armed", { quality: "GREEN" }, []],
    ["GREEN→YELLOW one again", { quality: "YELLOW" }, ["quality:YELLOW"]],
    ["tier 10K→2K one", { quality: "YELLOW", tier: "TIER_2K" }, ["tier:TIER_2K"]],
    ["tier 2K→UNLIMITED none", { quality: "YELLOW", tier: "TIER_UNLIMITED" }, []],
    ["tier UNLIMITED→NOT_SET ignored", { quality: "YELLOW", tier: "TIER_NOT_SET" }, []],
    ["templatesBad 0→2 one", { quality: "YELLOW", tier: "TIER_UNLIMITED", templatesBad: 2 }, ["templatesBad:2"]],
    ["templatesBad 2→1 none", { quality: "YELLOW", tier: "TIER_UNLIMITED", templatesBad: 1 }, []],
    ["templatesBad 1→3 one", { quality: "YELLOW", tier: "TIER_UNLIMITED", templatesBad: 3 }, ["templatesBad:3"]],
    ["templates unknown none", { quality: "YELLOW", tier: "TIER_UNLIMITED", templatesBad: null }, []],
    [
      "several drops in one check list every one",
      { quality: "RED", messaging: "BLOCKED", phoneStatus: "FLAGGED", nameStatus: "DECLINED", accountReview: "REJECTED", tier: "TIER_UNLIMITED", templatesBad: 3 },
      ["quality:RED", "messaging:BLOCKED", "phoneStatus:FLAGGED", "nameStatus:DECLINED", "accountReview:REJECTED"],
    ],
    [
      "phone FLAGGED→BANNED one",
      { quality: "RED", messaging: "BLOCKED", phoneStatus: "BANNED", nameStatus: "DECLINED", accountReview: "REJECTED", tier: "TIER_UNLIMITED", templatesBad: 3 },
      ["phoneStatus:BANNED"],
    ],
  ];

  it("walks the table in order", () => {
    let alerts: HealthAlerts | null = null;
    steps.forEach(([name, state, expected], i) => {
      const h = health(state, i);
      const before: HealthAlerts | null = alerts ? JSON.parse(JSON.stringify(alerts)) : null;
      const out = evaluateAlerts(alerts, h, at(i));
      expect({ name, changes: out.changes.map((c) => `${c.signal}:${c.to}`) }).toEqual({ name, changes: expected });
      if (name === "RED→unknown none") expect(out.alerts).toEqual(before); // alerts unchanged
      if (name.startsWith("RED→GREEN")) expect(out.alerts.levels.quality).toBe(0); // re-armed
      alerts = out.alerts;
    });
    expect(alerts!.baselineAt).toBe(at(0).toISOString());
  });

  it("baseline sets levels silently even for a bad first state", () => {
    const out = evaluateAlerts(null, health({ quality: "RED", messaging: "BLOCKED", tier: "TIER_250", templatesBad: 4 }, 0), T0);
    expect(out.changes).toEqual([]);
    expect(out.alerts.levels).toMatchObject({ quality: 2, messaging: 2, tier: 250, templatesBad: 4 });
    expect(out.alerts.baselineAt).toBe(T0.toISOString());
  });

  it("a change carries the previous level and the new value", () => {
    const base = evaluateAlerts(null, health({}, 0), T0).alerts;
    const out = evaluateAlerts(base, health({ tier: "TIER_2K" }, 1), at(1));
    expect(out.changes).toEqual([{ signal: "tier", from: 10_000, to: "TIER_2K" }]);
    const up = evaluateAlerts(base, health({ tier: "TIER_UNLIMITED" }, 1), at(1)).alerts;
    expect(up.levels.tier).toBe(UNLIMITED_LEVEL);
    expect(JSON.parse(JSON.stringify(up)).levels.tier).toBe(UNLIMITED_LEVEL); // JSON-safe
    expect(evaluateAlerts(up, health({ tier: "TIER_100K" }, 2), at(2)).changes).toEqual([
      { signal: "tier", from: UNLIMITED_LEVEL, to: "TIER_100K" },
    ]);
  });

  it("alert levels per signal", () => {
    expect(alertLevel("quality", "GREEN")).toBe(0);
    expect(alertLevel("quality", "YELLOW")).toBe(1);
    expect(alertLevel("quality", "RED")).toBe(2);
    expect(alertLevel("quality", "unknown")).toBeNull();
    expect(alertLevel("messaging", "LIMITED")).toBe(1);
    expect(alertLevel("phoneStatus", "RATE_LIMITED")).toBe(1);
    expect(alertLevel("phoneStatus", "MESSAGING_LIMIT_REACHED")).toBe(1);
    expect(alertLevel("phoneStatus", "RESTRICTED")).toBe(2);
    expect(alertLevel("phoneStatus", "PENDING")).toBe(0);
    expect(alertLevel("nameStatus", "EXPIRED")).toBe(2);
    expect(alertLevel("nameStatus", "PENDING_REVIEW")).toBe(0);
    expect(alertLevel("accountReview", "REJECTED")).toBe(2);
    expect(alertLevel("accountReview", "PENDING")).toBe(0);
    expect(alertLevel("tier", "TIER_NOT_SET")).toBeNull();
    expect(alertLevel("tier", "TIER_1K")).toBe(1000);
    expect(alertLevel("templatesBad", 0)).toBe(0);
    expect(alertLevel("templatesBad", null)).toBeNull();
  });
});
