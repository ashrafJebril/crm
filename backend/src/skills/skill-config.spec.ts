import { HttpException } from "@nestjs/common";
import { makeSkillsWorld, WS } from "./__fixtures__/skills-world";
import { SKILL_CATALOG, SKILL_CONFIG_MAX_BYTES, SKILL_KEYS, catalogEntry, toolSkillMap, CORE_TOOLS } from "./skill-catalog";
import { mergeOnUpdate, validateSkillConfig } from "./skill-config";
import { SKILL_ERROR_KEYS, skillError, skillErrorStatus } from "./skill-errors";
import { NeverConnected } from "./connector-presence";

const fields = (key: string) => catalogEntry(SKILL_CATALOG, key)!.configFields;

describe("skill config (SP-22)", () => {
  it("invalid config is 400 with field errors", async () => {
    expect(validateSkillConfig(fields("lead_capture"), { nope: 1 })).toEqual({ ok: false, errors: [{ key: "nope", code: "unknown_key" }] });
    expect(validateSkillConfig(fields("lead_capture"), { qualificationNotes: 5 })).toEqual({ ok: false, errors: [{ key: "qualificationNotes", code: "wrong_type" }] });
    expect(validateSkillConfig(fields("lead_capture"), { qualificationNotes: "x".repeat(1001) })).toEqual({
      ok: false,
      errors: [{ key: "qualificationNotes", code: "too_long" }],
    });
    expect(validateSkillConfig(fields("lead_capture"), { allowedTags: Array.from({ length: 21 }, (_, i) => `t${i}`) })).toEqual({
      ok: false,
      errors: [{ key: "allowedTags", code: "above_max" }],
    });
    expect(validateSkillConfig(fields("support_tickets"), { defaultPriority: "urgent" })).toEqual({
      ok: false,
      errors: [{ key: "defaultPriority", code: "not_an_option" }],
    });
    expect(validateSkillConfig(fields("lead_capture"), { qualificationNotes: "y".repeat(SKILL_CONFIG_MAX_BYTES) })).toEqual({
      ok: false,
      errors: [{ key: "", code: "too_large" }],
    });
    expect(validateSkillConfig(fields("lead_capture"), [])).toMatchObject({ ok: false });
    // Defaults fill, strings and tags are trimmed and de-duplicated.
    expect(validateSkillConfig(fields("lead_capture"), { allowedTags: [" vip ", "vip", "wholesale", ""] })).toEqual({
      ok: true,
      config: { qualificationNotes: "", allowedTags: ["vip", "wholesale"] },
    });
    // Through the service: a 400 with the errors.
    const w = makeSkillsWorld();
    const err = await w.skills.install(WS, "lead_capture", { config: { nope: true } }, null).catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(400);
    expect(err.getResponse()).toMatchObject({ message: "skills.invalid_config", errors: [{ key: "nope", code: "unknown_key" }] });
  });

  it("merge on update keeps passing values, fills defaults and reports the rest", () => {
    const f = [
      { key: "a", type: "text" as const, labelEn: "", labelAr: "", required: false, maxLength: 3 },
      { key: "b", type: "number" as const, labelEn: "", labelAr: "", required: false, default: 24 },
      { key: "c", type: "text" as const, labelEn: "", labelAr: "", required: true },
    ];
    expect(mergeOnUpdate(f, { a: "ok", gone: 1, b: "not a number" })).toEqual({
      config: { a: "ok", b: 24 },
      dropped: ["b", "gone"],
      needsConfig: true,
      missing: ["c"],
    });
    expect(mergeOnUpdate(f, { a: "toolong", c: "x" })).toMatchObject({ dropped: ["a"], needsConfig: false });
  });

  it("catalog shape: six keys, every tool in one skill, defaults and errors", async () => {
    expect(SKILL_CATALOG.map((e) => e.key)).toEqual([...SKILL_KEYS]);
    const map = toolSkillMap(SKILL_CATALOG);
    const all = SKILL_CATALOG.flatMap((e) => e.tools);
    expect(new Set(all).size).toBe(all.length);
    expect(map.get("create_appointment")).toBe("booking");
    expect(map.has(CORE_TOOLS[0])).toBe(false);
    expect(SKILL_CATALOG.filter((e) => e.defaultInstalled).map((e) => e.key)).toEqual(["booking", "customer_records", "photos"]);
    for (const k of SKILL_ERROR_KEYS) {
      const e = skillError(k, { x: 1 });
      expect(e.getStatus()).toBe(skillErrorStatus(k));
      expect(e.getResponse()).toEqual({ statusCode: skillErrorStatus(k), message: k, x: 1 });
    }
    expect(await new NeverConnected().isConnected()).toBe(false);
  });
});
