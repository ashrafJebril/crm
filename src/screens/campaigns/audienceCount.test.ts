import { describe, expect, it } from "vitest";
import { makeTx } from "@/lib/tx";
import { audienceCountLabel, audienceKind, audienceKindLabel } from "./audienceCount";

const en = makeTx("en");
const ar = makeTx("ar");

describe("audienceCountLabel", () => {
  it("formats a known count", () => {
    expect(audienceCountLabel(1234, en)).toEqual({ text: (1234).toLocaleString(), unknown: false, title: undefined });
    expect(audienceCountLabel(0, en)).toMatchObject({ text: "0", unknown: false });
  });

  it("renders a null or missing count (too large to count right now) as an em dash with a tooltip, never 0", () => {
    for (const n of [null, undefined]) {
      const l = audienceCountLabel(n, en);
      expect(l.text).toBe("—");
      expect(l.unknown).toBe(true);
      expect(l.title).toBe("Too large to count right now");
    }
    expect(audienceCountLabel(null, ar).title).toBe("العدد كبير جدًا لحسابه الآن");
  });
});

describe("audienceKind", () => {
  const segs = [{ id: "s", origin: "crm" }, { id: "m", origin: "manual" }, { id: "h", origin: "hjz" }];
  it("badges smart, manual and deleted audiences", () => {
    expect(audienceKind(null, segs)).toBe("all");
    expect(audienceKind("s", segs)).toBe("smart");
    expect(audienceKind("m", segs)).toBe("group");
    expect(audienceKind("h", segs)).toBe("group");
    expect(audienceKind("gone", segs)).toBe("deleted");
    expect(audienceKind("gone", null)).toBe("unknown");
  });
  it("labels them in both languages", () => {
    expect(audienceKindLabel("smart", en)).toBe("Smart");
    expect(audienceKindLabel("smart", ar)).toBe("ذكي");
    expect(audienceKindLabel("deleted", ar)).toBe("جمهور محذوف");
    expect(audienceKindLabel("all", en)).toBeNull();
  });
});
