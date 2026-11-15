import { describe, expect, it } from "vitest";
import { makeTx } from "@/lib/tx";
import { audienceCountLabel, audienceKind, audienceKindLabel, recipientsLabel } from "./audienceCount";

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

describe("recipientsLabel (final review M1)", () => {
  it("shows — for draft or scheduled campaigns on a smart audience", () => {
    for (const status of ["draft", "scheduled"]) {
      const l = recipientsLabel({ status, recipients: 0 }, "smart", en);
      expect(l.text).toBe("—");
      expect(l.title).toBe("Worked out when the campaign starts");
      expect(recipientsLabel({ status, recipients: 0 }, "smart", ar).title).toBe("يُحدَّد عند بدء الحملة");
    }
  });
  it("keeps the number for launched campaigns and for groups", () => {
    expect(recipientsLabel({ status: "completed", recipients: 1200 }, "smart", en).text).toBe("1,200");
    expect(recipientsLabel({ status: "draft", recipients: 7 }, "group", en).text).toBe("7");
    expect(recipientsLabel({ status: "draft", recipients: 7 }, "unknown", en).text).toBe("7");
  });
});
