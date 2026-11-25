import { describe, expect, it } from "vitest";
import { makeTx } from "@/lib/tx";
import type { SenderOption } from "@/lib/types";
import {
  assignSender,
  effectiveSelection,
  eligibleSenders,
  isolateLtr,
  makePrimary,
  senderUnavailable,
  showNumberTable,
  showSendFrom,
  splitCounts,
  splitRows,
  toggleSender,
} from "./senderModel";

const en = makeTx("en");
const ar = makeTx("ar");
const ARABIC = /[؀-ۿ]/;

const s = (channelId: string, over: Partial<SenderOption> = {}): SenderOption => ({
  channelId,
  displayName: channelId.toUpperCase(),
  phoneNumber: `+9627900000${channelId.length}`,
  isDefault: false,
  provider: "zernio",
  eligible: true,
  reason: null,
  ...over,
});

describe("senderModel", () => {
  it("round-robin split counts match backend formula", () => {
    for (let k = 1; k <= 10; k++) {
      const senders = Array.from({ length: k }, (_, i) => `s${i}`);
      for (let n = 0; n <= 300; n++) {
        const tally = new Array(k).fill(0);
        for (let i = 0; i < n; i++) tally[senders.indexOf(assignSender(i, senders))]++;
        expect(splitCounts(n, senders)).toEqual(tally);
      }
    }
    // The backend spec's table (senders.spec.ts).
    expect(splitCounts(10, ["a", "b", "c"])).toEqual([4, 3, 3]);
    expect(splitCounts(7, ["a", "b", "c"])).toEqual([3, 2, 2]);
    expect(splitCounts(2, ["a", "b", "c"])).toEqual([1, 1, 0]);
    expect(splitCounts(5, [])).toEqual([]);
    expect(assignSender(4, ["a", "b", "c"])).toBe("b");
  });

  it("showSendFrom hides the picker for one number unless a non-default choice is saved", () => {
    const def = s("d", { isDefault: true });
    const other = s("o");
    const meta = s("m", { eligible: false, reason: "provider_meta", provider: "meta" });
    // One eligible number (a Meta one doesn't count): hidden.
    expect(showSendFrom([def, meta], [])).toBe(false);
    expect(showSendFrom([def], ["d"])).toBe(false);
    // Two eligible: shown.
    expect(showSendFrom([def, other], [])).toBe(true);
    // One eligible, but the saved choice is not the default: shown, so it can be changed back.
    expect(showSendFrom([def, meta], ["m"])).toBe(true);
    expect(showSendFrom([def], ["gone"])).toBe(true);
    expect(eligibleSenders([def, meta, other]).map((x) => x.channelId)).toEqual(["d", "o"]);
  });

  it("selection keeps the primary first, respects the plan limit and re-orders by Make primary", () => {
    const list = [s("d", { isDefault: true }), s("a"), s("b")];
    expect(effectiveSelection([], list)).toEqual(["d"]);
    expect(effectiveSelection(["a"], list)).toEqual(["a"]);
    expect(toggleSender(["d"], "a", 3)).toEqual(["d", "a"]);
    expect(toggleSender(["d", "a"], "d", 3)).toEqual(["a"]);
    // The last number can't be unticked.
    expect(toggleSender(["d"], "d", 3)).toEqual(["d"]);
    // At the plan limit nothing more is added; with a limit of 1 the tick swaps.
    expect(toggleSender(["d", "a"], "b", 2)).toEqual(["d", "a"]);
    expect(toggleSender(["d"], "b", 1)).toEqual(["b"]);
    expect(makePrimary(["d", "a", "b"], "b")).toEqual(["b", "d", "a"]);
    expect(makePrimary(["d"], "x")).toEqual(["d"]);
  });

  it("words unavailable numbers and isolates numbers inside options", () => {
    expect(senderUnavailable(s("m", { eligible: false, reason: "provider_meta" }), en)).toBe(
      "Campaigns send through Zernio numbers only",
    );
    expect(senderUnavailable(s("m", { eligible: false, reason: "provider_meta" }), ar)).toBe("ترسل الحملات عبر أرقام Zernio فقط");
    expect(senderUnavailable(s("n", { eligible: false, reason: "not_active" }), ar)).toMatch(ARABIC);
    expect(senderUnavailable(s("ok"), en)).toBeNull();
    expect(isolateLtr("+962 79")).toBe("⁦+962 79⁩");
  });

  it("orders the split largest first and decides when the per-number table shows", () => {
    const rows = splitRows([
      { channelId: "a", displayName: "A", phoneNumber: null, recipients: 3 },
      { channelId: "b", displayName: "B", phoneNumber: null, recipients: 4 },
    ]);
    expect(rows.map((r) => r.channelId)).toEqual(["b", "a"]);
    expect(rows[0]!.pct).toBe(57);
    const line = { channelId: "a", displayName: "A", phoneNumber: null, unknown: false, total: 1, sent: 1, delivered: 1, read: 0, replied: 0, failed: 0, skipped: 0 };
    expect(showNumberTable([line, { ...line, channelId: "b" }], "d")).toBe(true);
    expect(showNumberTable([line], "a")).toBe(false);
    expect(showNumberTable([line], "d")).toBe(true);
    expect(showNumberTable([line], null)).toBe(false);
    expect(showNumberTable([], "d")).toBe(false);
  });
});
