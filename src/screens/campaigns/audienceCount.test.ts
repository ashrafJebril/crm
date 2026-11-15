import { describe, expect, it } from "vitest";
import { makeTx } from "@/lib/tx";
import { audienceCountLabel } from "./audienceCount";

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
