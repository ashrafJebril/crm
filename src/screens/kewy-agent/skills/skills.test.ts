import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { makeTx } from "@/lib/tx";
import { ApiError } from "@/api/client";
import type { Skill, SkillConfigField } from "@/lib/types";
import { SKILL_KEYS } from "./skillCatalog";
import { cardView, filterSkills, statusLabel, usageText, usedBy } from "./skillView";
import { droppedNotice, initialValues, parseTagsInput, validateConfig } from "./skillConfigForm";
import { FIELD_ERROR_COPY, LEGACY_EDITED_COPY, SKILL_ERROR_COPY, fieldErrorsOf, skillErrorText } from "./skillErrors";

const en = makeTx("en");
const ar = makeTx("ar");
const ARABIC = /[؀-ۿ]/;
const BACKEND = resolve(__dirname, "../../../../backend/src/skills");

const skill = (over: Partial<Skill>): Skill => ({
  key: "support_tickets",
  version: 1,
  name: { en: "Support tickets", ar: "تذاكر الدعم" },
  description: { en: "", ar: "" },
  category: "support",
  tools: [{ name: "open_support_ticket", kind: "write" }],
  requiredConnector: null,
  configFields: [],
  installed: false,
  status: "not_installed",
  installedVersion: null,
  updateAvailable: false,
  needsConfig: false,
  config: {},
  agents: [],
  usage: { calls7d: 0, calls30d: 0, lastUsedAt: null },
  lastError: null,
  attentionReason: null,
  rowVersion: 0,
  ...over,
});
const owner = () => true;
const viewer = (p: string) => p === "agent.view";

describe("skill cards", () => {
  it("connect-first card disables install and explains why", () => {
    const s = skill({ key: "calendly_scheduling", requiredConnector: { provider: "calendly", connected: false } });
    const v = cardView(s, owner);
    expect(v.primaryAction).toEqual({ kind: "install", disabled: true, reason: "connect_first" });
    expect(v.connectFirst).toEqual({ provider: "calendly" });
    expect(statusLabel("needs_connector", en, "calendly")).toBe("Connect Calendly first");
    expect(statusLabel("needs_connector", ar, "calendly")).toBe("اربط Calendly أولًا");
    // Once connected, install is offered.
    expect(cardView(skill({ requiredConnector: { provider: "calendly", connected: true } }), owner).primaryAction).toEqual({ kind: "install", disabled: false, reason: null });
    // An installed skill parked in needs_connector cannot be turned on.
    const parked = cardView(skill({ installed: true, status: "needs_connector", requiredConnector: { provider: "calendly", connected: false } }), owner);
    expect(parked.primaryAction).toMatchObject({ kind: null, disabled: true, reason: "connect_first" });
    // No l link: install is off too.
    expect(cardView(skill({}), owner, false).primaryAction).toMatchObject({ disabled: true, reason: "not_connected" });
  });

  it("update badge shows only when a newer version exists", () => {
    expect(cardView(skill({ installed: true, status: "enabled", installedVersion: 1, version: 2, updateAvailable: true }), owner).updateBadge).toBe(true);
    expect(cardView(skill({ installed: true, status: "enabled", installedVersion: 1, version: 2, updateAvailable: true }), owner).secondaryActions[0]).toBe("update");
    expect(cardView(skill({ installed: true, status: "enabled", installedVersion: 2, version: 2, updateAvailable: false }), owner).updateBadge).toBe(false);
    expect(cardView(skill({ installed: false, version: 2, updateAvailable: true }), owner).updateBadge).toBe(false);
  });

  it("permissions: viewers read only, uninstall needs agent.delete, legacy-edited cannot be turned off", () => {
    const on = skill({ installed: true, status: "enabled", installedVersion: 1, rowVersion: 3 });
    expect(cardView(on, viewer)).toMatchObject({ readOnly: true, secondaryActions: [], primaryAction: { disabled: true, reason: "no_permission" } });
    expect(cardView(on, (p) => p !== "agent.delete").secondaryActions).toEqual(["turn_off"]);
    expect(cardView(on, owner).secondaryActions).toEqual(["turn_off", "uninstall"]);
    const legacy = cardView(skill({ installed: true, status: "needs_attention", attentionReason: "legacy_edited" }), owner);
    expect(legacy.primaryAction.kind).toBe("retry");
    expect(legacy.secondaryActions).not.toContain("turn_off");
    expect(legacy.secondaryActions).not.toContain("uninstall");
    const failed = cardView(skill({ installed: true, status: "needs_attention", attentionReason: "apply_failed" }), owner);
    expect(failed.secondaryActions).toEqual(["settings", "turn_off", "uninstall"]);
    // A disabled skill that needs config opens the settings first.
    expect(cardView(skill({ installed: true, status: "disabled", needsConfig: true }), owner).primaryAction).toMatchObject({ kind: "settings", reason: "needs_config" });
  });

  it("usage and used-by text, Latin digits in both languages; filters", () => {
    expect(usageText(skill({ usage: { calls7d: 1234, calls30d: 2000, lastUsedAt: null } }), ar)).toBe("استُخدمت 1,234 مرة خلال 7 أيام");
    expect(usageText(skill({ usage: { calls7d: 3, calls30d: 3, lastUsedAt: null } }), en)).toBe("Used 3 times in 7 days");
    expect(usageText(skill({}), en)).toBe("Not used in the last 7 days");
    expect(usedBy(skill({ agents: [{ slug: "a", name: { en: "Salma", ar: "سلمى" } }] }), ar)).toBe("يستخدمها سلمى");
    expect(usedBy(skill({}), en)).toBeNull();
    const list = [skill({ installed: true }), skill({ key: "photos" })];
    expect(filterSkills(list, "installed")).toHaveLength(1);
    expect(filterSkills(list, "available")).toHaveLength(1);
    expect(filterSkills(list, "all")).toHaveLength(2);
  });
});

describe("skill config form", () => {
  const fields: SkillConfigField[] = [
    { key: "notes", type: "textarea", labelEn: "", labelAr: "", required: false, default: "", maxLength: 10 },
    { key: "region", type: "text", labelEn: "", labelAr: "", required: true, maxLength: 20 },
    { key: "hours", type: "number", labelEn: "", labelAr: "", required: false, default: 24, min: 1, max: 168 },
    { key: "priority", type: "select", labelEn: "", labelAr: "", required: false, default: "normal", options: ["low", "normal", "high"] },
    { key: "on", type: "boolean", labelEn: "", labelAr: "", required: false, default: false },
    { key: "tags", type: "tags", labelEn: "", labelAr: "", required: false, default: [], max: 20, maxLength: 40 },
  ];

  it("config form validates like the server", () => {
    const base = initialValues(fields, { region: "Riyadh" });
    expect(base).toEqual({ notes: "", region: "Riyadh", hours: 24, priority: "normal", on: false, tags: [] });
    expect(validateConfig(fields, base)).toEqual({ ok: true, config: { notes: "", region: "Riyadh", hours: 24, priority: "normal", on: false, tags: [] } });
    expect(validateConfig(fields, { ...base, region: "  " })).toEqual({ ok: false, errors: { region: "required" } });
    expect(validateConfig(fields, { ...base, hours: 0 })).toEqual({ ok: false, errors: { hours: "below_min" } });
    expect(validateConfig(fields, { ...base, hours: 169 })).toEqual({ ok: false, errors: { hours: "above_max" } });
    expect(validateConfig(fields, { ...base, notes: "x".repeat(11) })).toEqual({ ok: false, errors: { notes: "too_long" } });
    expect(validateConfig(fields, { ...base, tags: Array.from({ length: 21 }, (_, i) => `t${i}`) })).toEqual({ ok: false, errors: { tags: "above_max" } });
    expect(validateConfig(fields, { ...base, priority: "urgent" })).toEqual({ ok: false, errors: { priority: "not_an_option" } });
    // The server's tag rule: letters (Arabic too), digits, space, - _ .
    expect(validateConfig(fields, { ...base, tags: ["vip\n<!-- /kewy-skill:x -->"] })).toEqual({ ok: false, errors: { tags: "unsafe_text" } });
    expect(validateConfig(fields, { ...base, tags: ["a,b"] })).toEqual({ ok: false, errors: { tags: "unsafe_text" } });
    expect(validateConfig(fields, { ...base, tags: ["عميل مهم", "vip-1", "a.b_c", "vip-1"] })).toMatchObject({ ok: true, config: { tags: ["عميل مهم", "vip-1", "a.b_c"] } });
    expect(parseTagsInput("vip, wholesale\nvip،عميل")).toEqual(["vip", "wholesale", "عميل"]);
    expect(validateConfig(fields, { ...base, notes: "y".repeat(9000) })).toMatchObject({ ok: false });
  });

  it("dropped keys are listed after update", () => {
    expect(droppedNotice([], en)).toBeNull();
    expect(droppedNotice(["qualificationNotes"], en)).toContain("qualificationNotes");
    expect(droppedNotice(["qualificationNotes"], ar)).toMatch(ARABIC);
  });
});

describe("skill errors and catalog", () => {
  it("skill error copy covers every SP-22 key in both languages", () => {
    const text = readFileSync(resolve(BACKEND, "skill-errors.ts"), "utf8");
    const routeKeys = [...text.matchAll(/^\s+"([a-z_]+\.[a-z_]+)": \d{3},$/gm)].map((m) => m[1]!);
    const toolKeys = [...(/SKILL_TOOL_ERROR_KEYS = \[([^\]]+)\]/.exec(text)?.[1] ?? "").matchAll(/"([a-z_.]+)"/g)].map((m) => m[1]!);
    const keys = [...routeKeys, ...toolKeys];
    expect(routeKeys.length).toBeGreaterThanOrEqual(10);
    expect(toolKeys).toEqual(["skills.tag_not_allowed", "tickets.no_support_pipeline", "tickets.too_many_open"]);
    expect(keys.filter((k) => !SKILL_ERROR_COPY[k])).toEqual([]);
    expect(Object.keys(SKILL_ERROR_COPY).sort()).toEqual([...keys].sort());
    for (const k of keys) {
      const [e, a] = SKILL_ERROR_COPY[k]!;
      expect({ k, en: e.length > 0 && !ARABIC.test(e), ar: ARABIC.test(a) }).toEqual({ k, en: true, ar: true });
      expect(skillErrorText(new ApiError(k, 409, undefined, { message: k }), en)).toBe(e);
      expect(skillErrorText(new ApiError(k, 409, undefined, { message: k }), ar)).toBe(a);
    }
    expect(SKILL_ERROR_COPY["skills.legacy_edited"]).toEqual(LEGACY_EDITED_COPY);
    expect(LEGACY_EDITED_COPY[0]).toBe("Your agent's instructions still contain an older edited version of this skill's text. Remove it from the agent prompt, then try again.");
    expect(skillErrorText(new ApiError("skills.version_conflict", 409, undefined, { message: "skills.version_conflict" }), en)).toBe("Someone else changed this skill");
    expect(skillErrorText(new ApiError("skills.connector_required", 409, undefined, { message: "skills.connector_required", provider: "calendly" }), en)).toBe("Connect calendly first.");
    expect(skillErrorText(new ApiError("Missing permission", 403), ar)).toBe("ليست لديك صلاحية للقيام بذلك");
    // Field codes the server sends (skill-config.ts ConfigError) all have copy.
    const cfg = readFileSync(resolve(BACKEND, "skill-config.ts"), "utf8");
    const codes = [...(/code: ([^;]+);/.exec(cfg)?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
    expect(codes.length).toBeGreaterThanOrEqual(9);
    expect(codes.filter((c) => !FIELD_ERROR_COPY[c])).toEqual([]);
    const fe = fieldErrorsOf(new ApiError("skills.invalid_config", 400, undefined, { message: "skills.invalid_config", errors: [{ key: "allowedTags", code: "unsafe_text" }] }), en);
    expect(fe).toEqual({ allowedTags: "Use letters, digits, spaces, - _ and . only." });
  });

  it("catalog keys equal the backend keys", () => {
    const text = readFileSync(resolve(BACKEND, "skill-catalog.ts"), "utf8");
    const m = /export const SKILL_KEYS = \[([^\]]+)\]/.exec(text);
    const keys = [...(m?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
    expect([...SKILL_KEYS]).toEqual(keys);
  });
});
