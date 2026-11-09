import {
  VAR_FIELDS,
  type CustomDef,
  fieldLabel,
  formatCustomValue,
  isNativeSlot,
  legacyToVarMap,
  metaSafe,
  missingSkipCode,
  resolveSlot,
  resolveVarMap,
  validateVarMap,
  validateVarMapShape,
  zernioVariableFor,
} from "./var-map";

const def = (over: Partial<CustomDef> & { key: string }): CustomDef => ({
  id: `def-${over.key}`,
  label: over.key,
  labelAr: over.key,
  type: "text",
  options: null,
  ...over,
});

const defsOf = (...list: CustomDef[]) => new Map(list.map((d) => [d.key, d]));

const reason = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    const r = (e as { getResponse(): Record<string, unknown> }).getResponse();
    return { status: (e as { getStatus(): number }).getStatus(), message: r.message, slot: r.slot, reason: r.reason };
  }
  return null;
};

describe("var-map", () => {
  const city = def({ key: "city", label: "City", labelAr: "المدينة" });
  const due = def({ key: "service_due", label: "Service due", labelAr: "موعد الخدمة", type: "date" });
  const defs = defsOf(city, due);
  const contact = { name: "  Sara  ", firstName: "Sara", lastName: "", phone: "+962790000001", email: null };

  it("VAR_FIELDS lists the contact fields", () => {
    expect([...VAR_FIELDS]).toEqual(["name", "firstName", "lastName", "phone", "email"]);
  });

  it("resolveVarMap uses fallback for missing values and reports the first missing slot", () => {
    const map = {
      "1": { source: "field", key: "name" },
      "2": { source: "custom", key: "city", fallback: "  your city " },
      "3": { source: "static", value: "EID10" },
      "4": { source: "field", key: "firstName" },
    } as const;
    const ok = resolveVarMap(map, contact, { [city.id]: "   " }, { lang: "en", defs });
    // Blank and whitespace-only values count as missing; the fallback is trimmed.
    expect(ok).toEqual({ ok: true, values: ["Sara", "your city", "EID10", "Sara"], usedFallback: [2] });

    // Several slots missing: the lowest-numbered one is reported.
    const missing = resolveVarMap(
      {
        "1": { source: "field", key: "lastName" },
        "2": { source: "custom", key: "service_due" },
        "3": { source: "field", key: "email" },
      },
      contact,
      {},
      { lang: "en", defs },
    );
    expect(missing).toEqual({ ok: false, missing: { slot: "1", source: "field", key: "lastName" } });
    // Slot order is numeric, not lexical ("10" after "2").
    const ten: Record<string, { source: "static"; value: string } | { source: "field"; key: "email" }> = {};
    for (let i = 1; i <= 10; i++) ten[String(i)] = { source: "static", value: `v${i}` };
    ten["2"] = { source: "field", key: "email" };
    ten["10"] = { source: "field", key: "email" };
    expect(resolveVarMap(ten, contact, {}, { lang: "en", defs })).toMatchObject({ ok: false, missing: { slot: "2" } });

    // null and undefined are missing too.
    expect(resolveVarMap({ "1": { source: "custom", key: "city" } }, contact, { [city.id]: null }, { lang: "en", defs })).toMatchObject({
      ok: false,
      missing: { source: "custom", key: "city" },
    });

    // Arabic passes through unchanged.
    const ar = resolveVarMap({ "1": { source: "custom", key: "city" } }, contact, { [city.id]: "عمّان الشميساني" }, { lang: "ar", defs });
    expect(ar).toEqual({ ok: true, values: ["عمّان الشميساني"], usedFallback: [] });

    // Values are made Meta-safe.
    const messy = resolveVarMap({ "1": { source: "custom", key: "city" } }, contact, { [city.id]: "a\nb\tc     d" }, { lang: "en", defs });
    expect(messy).toEqual({ ok: true, values: ["a b c   d"], usedFallback: [] });

    // A key that is not in this workspace's defs resolves as missing (never another workspace's value).
    expect(resolveVarMap({ "1": { source: "custom", key: "vip" } }, contact, { "def-vip": "yes" }, { lang: "en", defs })).toMatchObject({
      ok: false,
      missing: { slot: "1", source: "custom", key: "vip" },
    });
  });

  it("resolveSlot reports each slot independently", () => {
    expect(resolveSlot({ source: "field", key: "email" }, contact, {}, { lang: "en", defs })).toBeNull();
    expect(resolveSlot({ source: "field", key: "email", fallback: "you" }, contact, {}, { lang: "en", defs })).toEqual({
      value: "you",
      usedFallback: true,
    });
  });

  it("metaSafe collapses newlines, tabs and 4+ spaces and cuts at 1024 characters", () => {
    expect(metaSafe("a\r\nb\n\nc\td")).toBe("a b  c d");
    expect(metaSafe("a    b")).toBe("a   b");
    expect(metaSafe("a   b")).toBe("a   b");
    expect(metaSafe("x".repeat(2000))).toHaveLength(1024);
    // Never splits a surrogate pair.
    const emoji = "😀".repeat(1100);
    expect(Array.from(metaSafe(emoji))).toHaveLength(1024);
    expect(metaSafe("مرحبا")).toBe("مرحبا");
  });

  it("formatCustomValue formats number, date, boolean and select per language", () => {
    expect(formatCustomValue(def({ key: "n", type: "number" }), 12.5, "en")).toBe("12.5");
    expect(formatCustomValue(def({ key: "n", type: "number" }), 0, "ar")).toBe("0");
    expect(formatCustomValue(def({ key: "d", type: "date" }), "2026-11-20", "en")).toBe("2026-11-20");
    expect(formatCustomValue(def({ key: "d", type: "date" }), "2026-11-20T10:00:00.000Z", "en")).toBe("2026-11-20");
    expect(formatCustomValue(def({ key: "d", type: "date" }), "not a date", "en")).toBeNull();
    const b = def({ key: "b", type: "boolean" });
    expect(formatCustomValue(b, true, "en")).toBe("Yes");
    expect(formatCustomValue(b, false, "en")).toBe("No");
    expect(formatCustomValue(b, true, "ar")).toBe("نعم");
    expect(formatCustomValue(b, false, "ar")).toBe("لا");
    expect(formatCustomValue(b, "true", "en")).toBe("Yes");
    const sel = def({ key: "s", type: "select", options: ["gold", "silver"] });
    expect(formatCustomValue(sel, "gold", "ar")).toBe("gold");
    const labelled = def({
      key: "s",
      type: "select",
      options: [{ value: "gold", label: "Gold", labelAr: "ذهبي" }],
    });
    expect(formatCustomValue(labelled, "gold", "ar")).toBe("ذهبي");
    expect(formatCustomValue(labelled, "gold", "en")).toBe("Gold");
    expect(formatCustomValue(labelled, "bronze", "en")).toBe("bronze");
    expect(formatCustomValue(def({ key: "t" }), "  hi  ", "en")).toBe("  hi  ");
    expect(formatCustomValue(def({ key: "t" }), null, "en")).toBeNull();
    expect(formatCustomValue(def({ key: "t" }), { a: 1 }, "en")).toBeNull();
  });

  it("validateVarMap rejects missing or extra slots, unknown or foreign custom keys and empty static values", () => {
    const wsA = defsOf(city);
    // A key defined only in workspace B (service_due) fails in A.
    const cases: Array<[unknown, number, string, string]> = [
      [{ "1": { source: "field", key: "name" } }, 2, "2", "missing_slot"],
      [{ "1": { source: "field", key: "name" }, "2": { source: "field", key: "phone" } }, 1, "2", "extra_slot"],
      [{ "1": { source: "custom", key: "service_due" } }, 1, "1", "unknown_custom_field"],
      [{ "1": { source: "custom", key: "nope" } }, 1, "1", "unknown_custom_field"],
      [{ "1": { source: "static", value: "   " } }, 1, "1", "empty_value"],
      [{ "1": { source: "field", key: "company" } }, 1, "1", "bad_key"],
      [{ "1": { source: "contact", key: "name" } }, 1, "1", "bad_source"],
      [{ "1": { source: "static", value: "x".repeat(1025) } }, 1, "1", "too_long"],
      [{ "1": { source: "field", key: "name", fallback: "y".repeat(1025) } }, 1, "1", "too_long"],
      [{ "0": { source: "field", key: "name" } }, 1, "0", "extra_slot"],
    ];
    for (const [map, slotCount, slot, why] of cases) {
      expect({ map, r: reason(() => validateVarMap(map, { slotCount, customDefs: wsA })) }).toEqual({
        map,
        r: { status: 400, message: "campaigns.var_map_invalid", slot, reason: why },
      });
    }
    const ok = validateVarMap(
      { "2": { source: "static", value: " Hi " }, "1": { source: "custom", key: "city", fallback: " there " } },
      { slotCount: 2, customDefs: wsA },
    );
    expect(ok).toEqual({ "1": { source: "custom", key: "city", fallback: "there" }, "2": { source: "static", value: "Hi" } });
    // An archived def is not offered to validation by callers; an empty map is valid for a 0-slot template.
    expect(validateVarMap({}, { slotCount: 0, customDefs: wsA })).toEqual({});
  });

  it("validateVarMapShape checks the shape only (any slot count, any custom key)", () => {
    expect(validateVarMapShape({ "1": { source: "custom", key: "anything" }, "3": { source: "field", key: "email" } })).toEqual({
      "1": { source: "custom", key: "anything" },
      "3": { source: "field", key: "email" },
    });
    for (const bad of [null, [], "x", 5]) {
      expect(reason(() => validateVarMapShape(bad))).toMatchObject({ status: 400, message: "campaigns.var_map_invalid", reason: "bad_source" });
    }
    expect(reason(() => validateVarMapShape({ "1": "name" }))).toMatchObject({ slot: "1", reason: "bad_source" });
    expect(reason(() => validateVarMapShape({ "1": { source: "custom", key: "" } }))).toMatchObject({ slot: "1", reason: "bad_key" });
    expect(reason(() => validateVarMapShape({ a: { source: "field", key: "name" } }))).toMatchObject({ slot: "a", reason: "extra_slot" });
    const many: Record<string, unknown> = {};
    for (let i = 1; i <= 101; i++) many[String(i)] = { source: "static", value: "x" };
    expect(reason(() => validateVarMapShape(many))).toMatchObject({ slot: "101", reason: "extra_slot" });
  });

  it("legacy variables convert to varMap", () => {
    expect(
      legacyToVarMap([{ field: "name" }, { field: "phone" }, { field: "email" }, { field: "custom", customValue: " EID " }]),
    ).toEqual({
      "1": { source: "field", key: "name" },
      "2": { source: "field", key: "phone" },
      "3": { source: "field", key: "email" },
      "4": { source: "static", value: "EID" },
    });
    expect(legacyToVarMap([])).toEqual({});
    expect(reason(() => legacyToVarMap([{ field: "name" }, { field: "company" }]))).toEqual({
      status: 400,
      message: "campaigns.var_map_invalid",
      slot: "2",
      reason: "bad_key",
    });
    expect(reason(() => legacyToVarMap([{ field: "custom", customValue: "" }]))).toMatchObject({ slot: "1", reason: "empty_value" });
  });

  it("native slots and their Zernio variables", () => {
    expect(isNativeSlot({ source: "static", value: "x" })).toBe(true);
    expect(isNativeSlot({ source: "field", key: "phone" })).toBe(true);
    expect(isNativeSlot({ source: "field", key: "name" })).toBe(true);
    expect(isNativeSlot({ source: "field", key: "firstName" })).toBe(false);
    expect(isNativeSlot({ source: "field", key: "email" })).toBe(false);
    expect(isNativeSlot({ source: "custom", key: "city" })).toBe(false);
    expect(zernioVariableFor({ source: "static", value: "x" }, "x")).toEqual({ field: "custom", customValue: "x" });
    expect(zernioVariableFor({ source: "field", key: "phone" }, "+9627")).toEqual({ field: "phone" });
    expect(zernioVariableFor({ source: "field", key: "name" }, "Sara")).toEqual({ field: "name" });
    expect(zernioVariableFor({ source: "custom", key: "city" }, "Amman")).toEqual({ field: "custom", customValue: "Amman" });
    expect(zernioVariableFor({ source: "field", key: "email" }, "a@b.c")).toEqual({ field: "custom", customValue: "a@b.c" });
  });

  it("skip codes and labels", () => {
    expect(missingSkipCode("custom", "service_due")).toBe("skip:missing_value:custom.service_due");
    expect(missingSkipCode("field", "email")).toBe("skip:missing_value:field.email");
    expect(fieldLabel("custom", "service_due", defs)).toEqual({ label: "Service due", labelAr: "موعد الخدمة" });
    expect(fieldLabel("field", "email", defs)).toEqual({ label: "Email", labelAr: "البريد الإلكتروني" });
    expect(fieldLabel("custom", "gone", defs)).toEqual({ label: "gone", labelAr: "gone" });
  });
});
