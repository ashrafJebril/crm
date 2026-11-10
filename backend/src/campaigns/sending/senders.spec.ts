import { ZernioRateLimitError } from "../../integrations/zernio.client";
import {
  assignSender,
  effectiveSenderIds,
  normalizeSenderWrite,
  sameTemplateCopy,
  splitCounts,
  templateOnSenders,
} from "./senders";

const errOf = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    if (typeof p === "function") p();
    else await p;
  } catch (e) {
    const r = (e as { getResponse(): Record<string, unknown> }).getResponse();
    return { status: (e as { getStatus(): number }).getStatus(), ...r };
  }
  return null;
};

describe("senders", () => {
  it("effectiveSenderIds: the array, else the legacy id, else [] (the default number)", () => {
    expect(effectiveSenderIds({ senderChannelIds: ["a", "b"], senderChannelId: "a" })).toEqual(["a", "b"]);
    expect(effectiveSenderIds({ senderChannelIds: [], senderChannelId: "x" })).toEqual(["x"]);
    expect(effectiveSenderIds({ senderChannelId: "x" })).toEqual(["x"]);
    expect(effectiveSenderIds({ senderChannelIds: [], senderChannelId: null })).toEqual([]);
    expect(effectiveSenderIds({})).toEqual([]);
  });

  it("splitCounts equals round-robin assignment", () => {
    for (let k = 1; k <= 10; k++) {
      const senders = Array.from({ length: k }, (_, i) => `s${i}`);
      for (let n = 0; n <= 1000; n++) {
        const tally = new Array(k).fill(0);
        for (let i = 0; i < n; i++) tally[senders.indexOf(assignSender(i, senders))]++;
        const counts = splitCounts(n, senders);
        if (counts.join() !== tally.join()) throw new Error(`n=${n} k=${k}: ${counts} != ${tally}`);
      }
    }
    expect(splitCounts(10, ["a", "b", "c"])).toEqual([4, 3, 3]);
    expect(splitCounts(7, ["a", "b", "c"])).toEqual([3, 2, 2]);
    expect(splitCounts(2, ["a", "b", "c"])).toEqual([1, 1, 0]);
    expect(splitCounts(5, [])).toEqual([]);
    expect(assignSender(4, ["a", "b", "c"])).toBe("b");
  });

  const copy = (over: Record<string, unknown> = {}) => ({
    id: "t",
    name: "eid_offer",
    status: "APPROVED",
    category: "MARKETING",
    language: "ar",
    components: [
      { type: "HEADER", format: "IMAGE" },
      { type: "BODY", text: "مرحبا {{1}}" },
      { type: "FOOTER", text: "Kewy" },
      { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Stop" }, { type: "URL", text: "Shop", url: "https://x" }] },
    ],
    ...over,
  });

  it("sameTemplateCopy compares body, header format, footer and buttons", () => {
    expect(sameTemplateCopy(copy(), copy())).toBe(true);
    // Case of component types and id/category differences do not matter.
    const lower = copy({
      id: "other",
      category: "UTILITY",
      components: [
        { type: "header", format: "image" },
        { type: "body", text: "مرحبا {{1}}", example: { body_text: [["x"]] } },
        { type: "footer", text: "Kewy" },
        { type: "buttons", buttons: [{ type: "quick_reply", text: "Stop" }, { type: "url", text: "Shop", url: "https://y" }] },
      ],
    });
    expect(sameTemplateCopy(copy(), lower)).toBe(true);
    const with_ = (i: number, c: Record<string, unknown> | null) => {
      const comps = [...(copy().components as Array<Record<string, unknown>>)];
      if (c) comps[i] = c;
      else comps.splice(i, 1);
      return copy({ components: comps });
    };
    expect(sameTemplateCopy(copy(), with_(1, { type: "BODY", text: "Hello {{1}}" }))).toBe(false);
    expect(sameTemplateCopy(copy(), with_(0, { type: "HEADER", format: "VIDEO" }))).toBe(false);
    expect(sameTemplateCopy(copy(), with_(0, null))).toBe(false);
    expect(sameTemplateCopy(copy(), with_(2, { type: "FOOTER", text: "Other" }))).toBe(false);
    expect(sameTemplateCopy(copy(), with_(3, { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Stop" }] }))).toBe(false);
    expect(
      sameTemplateCopy(copy(), with_(3, { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Stop" }, { type: "PHONE_NUMBER", text: "Shop" }] })),
    ).toBe(false);
    // Text headers compare their text too.
    const textHeader = (t: string) => copy({ components: [{ type: "HEADER", format: "TEXT", text: t }, { type: "BODY", text: "b" }] });
    expect(sameTemplateCopy(textHeader("Hi"), textHeader("Hi"))).toBe(true);
    expect(sameTemplateCopy(textHeader("Hi"), textHeader("Yo"))).toBe(false);
  });

  it("templateOnSenders reports senders missing the template or holding a different copy", async () => {
    const lists: Record<string, unknown> = {
      "acc-A": [copy(), copy({ name: "other" })],
      "acc-B": [copy({ language: "ar_SA" })], // same base language
      "acc-C": [copy({ status: "PENDING" })], // not approved → missing
      "acc-D": [copy({ components: [{ type: "BODY", text: "different" }] })], // different copy → missing
      "acc-E": [copy({ language: "en" })], // other language → missing
      "acc-F": new Error("zernio down"),
    };
    const zernio = {
      whatsappTemplates: jest.fn(async (acc: string) => {
        const v = lists[acc];
        if (v instanceof Error) throw v;
        return v as never;
      }),
    };
    const s = (id: string, acc = `acc-${id}`) => ({ channelId: id, accountId: acc });
    const senders = [s("A"), s("B"), s("C"), s("D"), s("E"), s("F"), s("A2", "acc-A")];
    const r = await templateOnSenders(zernio, senders, { name: "eid_offer", lang: "ar" });
    expect(r).toEqual({ missing: ["C", "D", "E"], failed: ["F"], paused: [] });
    // One read per account (A and A2 share acc-A).
    expect(zernio.whatsappTemplates).toHaveBeenCalledTimes(6);

    // The primary lacking it is missing too, and the others are judged by presence alone.
    const r2 = await templateOnSenders(zernio, [s("C"), s("A"), s("D")], { name: "eid_offer", lang: "ar" });
    expect(r2).toEqual({ missing: ["C"], failed: [], paused: [] });
    // The primary unreadable: it is failed, and the others are judged by presence alone.
    const r3 = await templateOnSenders(zernio, [s("F"), s("A"), s("C")], { name: "eid_offer", lang: "ar" });
    expect(r3).toEqual({ missing: ["C"], failed: ["F"], paused: [] });
    expect(await templateOnSenders(zernio, [], { name: "eid_offer", lang: "ar" })).toEqual({ missing: [], failed: [], paused: [] });
  });

  it("templateOnSenders classifies paused and disabled copies (SP-14 ruling 10)", async () => {
    const lists: Record<string, unknown> = {
      "acc-A": [copy()],
      "acc-B": [copy({ status: "PAUSED" })],
      "acc-C": [copy({ language: "ar_SA", status: "DISABLED" })], // same base language
      "acc-D": [copy({ status: "PAUSED", language: "ar_SA" }), copy()], // an approved copy wins
      "acc-E": [],
      "acc-F": [copy({ status: "paused" })],
    };
    const zernio = { whatsappTemplates: jest.fn(async (acc: string) => lists[acc] as never) };
    const s = (id: string) => ({ channelId: id, accountId: `acc-${id}` });
    const r = await templateOnSenders(zernio, [s("A"), s("B"), s("C"), s("D"), s("E"), s("F")], { name: "eid_offer", lang: "ar" });
    expect(r).toEqual({
      missing: ["E"],
      failed: [],
      paused: [
        { channelId: "B", status: "paused" },
        { channelId: "C", status: "disabled" },
        { channelId: "F", status: "paused" },
      ],
    });
    // A paused primary: the others are judged by presence alone.
    const r2 = await templateOnSenders(zernio, [s("B"), s("A"), s("E")], { name: "eid_offer", lang: "ar" });
    expect(r2).toEqual({ missing: ["E"], failed: [], paused: [{ channelId: "B", status: "paused" }] });
  });

  it("templateOnSenders reads through the shared budget, and a 429 pauses it (SP-13 final review, R19)", async () => {
    const budget = { take: jest.fn(async () => {}), pause: jest.fn() };
    const zernio = {
      whatsappTemplates: jest.fn(async (acc: string) => {
        if (acc === "acc-B") throw new ZernioRateLimitError("slow", 4000);
        return [copy()] as never;
      }),
    };
    const s = (id: string, acc = `acc-${id}`) => ({ channelId: id, accountId: acc });
    const r = await templateOnSenders(zernio, [s("A"), s("A2", "acc-A"), s("B")], { name: "eid_offer", lang: "ar" }, { budget });
    // One token per account read; the rate-limited account fails closed and pauses the bucket.
    expect(budget.take).toHaveBeenCalledTimes(2);
    expect(budget.pause).toHaveBeenCalledWith(4000);
    expect(r).toEqual({ missing: [], failed: ["B"], paused: [] });
  });

  it("sender write keeps senderChannelId equal to the primary", async () => {
    // Neither: no change.
    expect(normalizeSenderWrite({})).toBeNull();
    // Only legacy.
    expect(normalizeSenderWrite({ senderChannelId: "a" })).toEqual({ senderChannelIds: ["a"], senderChannelId: "a" });
    expect(normalizeSenderWrite({ senderChannelId: null })).toEqual({ senderChannelIds: [], senderChannelId: null });
    // Only the array (duplicates removed, keeping the first).
    expect(normalizeSenderWrite({ senderChannelIds: ["b", "a", "b"] })).toEqual({ senderChannelIds: ["b", "a"], senderChannelId: "b" });
    expect(normalizeSenderWrite({ senderChannelIds: [] })).toEqual({ senderChannelIds: [], senderChannelId: null });
    // Both agreeing.
    expect(normalizeSenderWrite({ senderChannelIds: ["a", "b"], senderChannelId: "a" })).toEqual({
      senderChannelIds: ["a", "b"],
      senderChannelId: "a",
    });
    expect(normalizeSenderWrite({ senderChannelIds: [], senderChannelId: null })).toEqual({ senderChannelIds: [], senderChannelId: null });
    // Both conflicting.
    for (const dto of [
      { senderChannelIds: ["a", "b"], senderChannelId: "b" },
      { senderChannelIds: ["a"], senderChannelId: null },
      { senderChannelIds: [], senderChannelId: "a" },
    ]) {
      expect(await errOf(() => normalizeSenderWrite(dto))).toEqual({ status: 400, statusCode: 400, message: "campaigns.sender_conflict" });
    }
  });
});
