import { describe, expect, it } from "vitest";
import backendCatalog from "../../../../backend/src/lifecycle/lifecycle-catalog.ts?raw";
import backendDto from "../../../../backend/src/workflows/workflows.dto.ts?raw";
import {
  LIFECYCLE_CATALOG,
  LIFECYCLE_KEYS,
  REMINDER_OFFSET_DEFAULT,
  REMINDER_OFFSET_MAX,
  REMINDER_OFFSET_MIN,
  SKIP_REASON_COPY,
  customAutomationHref,
  skipReasonLabel,
} from "./lifecycleCatalog";
import { TRIGGER_META, TRIGGER_ORDER } from "@/screens/workflows/stepMeta";

const ARABIC = /[؀-ۿ]/;
const ARABIC_DIGITS = /[٠-٩]/;
const listOf = (src: string, name: string) =>
  [...new RegExp(`${name} = \\[([^\\]]*)\\]`).exec(src)![1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);

describe("catalog keys equal the backend keys", () => {
  it("keys, audiences, trigger types and placeholder counts match lifecycle-catalog.ts", () => {
    const keys = listOf(backendCatalog, "LIFECYCLE_KEYS");
    expect([...LIFECYCLE_KEYS]).toEqual(keys);
    for (const key of keys) {
      const block = new RegExp(`\\n  ${key}: \\{\\s*key: "${key}",\\s*audience: "(\\w+)",\\s*triggerType: "(\\w+)"`).exec(backendCatalog);
      expect(block, key).not.toBeNull();
      const def = LIFECYCLE_CATALOG[key as keyof typeof LIFECYCLE_CATALOG];
      expect({ key, audience: def.audience, triggerType: def.triggerType }).toEqual({ key, audience: block![1], triggerType: block![2] });
    }
    // One named variable per placeholder: booking bodies use {{1}}–{{4}}, ticket bodies {{1}}–{{2}}.
    for (const key of LIFECYCLE_KEYS) {
      const def = LIFECYCLE_CATALOG[key];
      if (def.audience === "staff") expect(def.variables).toEqual([]);
      else expect(def.variables).toHaveLength(key.startsWith("booking") ? 4 : 2);
    }
  });

  it("reminder bounds match the server", () => {
    const n = (name: string) => Number(new RegExp(`export const ${name} = (\\d+);`).exec(backendCatalog)![1]);
    expect(REMINDER_OFFSET_MIN).toBe(n("REMINDER_OFFSET_MIN"));
    expect(REMINDER_OFFSET_MAX).toBe(n("REMINDER_OFFSET_MAX"));
    expect(REMINDER_OFFSET_DEFAULT).toBe(n("REMINDER_OFFSET_DEFAULT_MIN"));
  });

  it("every row and skip reason has English and Arabic copy with Latin digits", () => {
    for (const key of LIFECYCLE_KEYS) {
      const d = LIFECYCLE_CATALOG[key];
      for (const [en, ar] of [d.title, d.description, ...d.variables]) {
        expect(en).not.toMatch(ARABIC);
        expect(ar).toMatch(ARABIC);
        expect(ar).not.toMatch(ARABIC_DIGITS);
      }
    }
    for (const r of ["opted_out", "channel_disconnected", "template_not_approved", "template_not_found", "workflow_inactive", "failed"]) {
      expect(SKIP_REASON_COPY[r], r).toBeDefined();
      expect(skipReasonLabel(r, "ar")).toMatch(ARABIC);
    }
    expect(skipReasonLabel("something_new", "en")).toBe("something new");
  });

  it("custom automations open the builder with a user trigger; the builder never offers the reminder", () => {
    const all = listOf(backendDto, "export const TRIGGER_TYPES");
    const systemOnly = listOf(backendDto, "SYSTEM_ONLY_TRIGGER_TYPES");
    expect(systemOnly).toEqual(["appointment_reminder_due"]);
    for (const t of systemOnly) expect(TRIGGER_ORDER).not.toContain(t);
    for (const t of TRIGGER_ORDER) expect(all).toContain(t);
    // Every user trigger the server accepts is offered.
    expect([...TRIGGER_ORDER].sort()).toEqual(all.filter((t) => !systemOnly.includes(t)).sort());
    for (const t of all) expect(TRIGGER_META[t as keyof typeof TRIGGER_META], t).toBeDefined();
    for (const key of LIFECYCLE_KEYS) {
      const href = customAutomationHref(key);
      const trigger = new URLSearchParams(href.split("?")[1]).get("trigger")!;
      expect(href.startsWith("#/workflows?new=1&trigger=")).toBe(true);
      expect(TRIGGER_ORDER).toContain(trigger);
    }
  });
});
