import { describe, it, expect } from "vitest";
import { emptyState, retarget, blockedReason, publishBody, activeSettings } from "./wizardState";

const tx = (en: string) => en;

describe("retarget — changing platform or type", () => {
  it("drops options the new type cannot do", () => {
    // The trap this exists for: set up a Reel with music, switch to Story,
    // publish. Without pruning the music travels with it and Zernio either
    // rejects the post or silently ignores the field.
    const reel = {
      ...emptyState("instagram"),
      kind: "reel" as const,
      options: { audioTrack: { audioId: "a1" }, trialReel: { graduationStrategy: "MANUAL" }, aiLabel: true },
    };
    const story = retarget(reel, { kind: "story" });
    expect(story.options.audioTrack).toBeUndefined();
    expect(story.options.trialReel).toBeUndefined();
    // aiLabel survives: Instagram supports it on Stories too.
    expect(story.options.aiLabel).toBe(true);
  });

  it("drops Instagram-only options when switching to Facebook", () => {
    const ig = {
      ...emptyState("instagram"),
      options: { location: "123", tagPeople: [{ username: "ada" }], commentsOff: true, aiLabel: true },
    };
    const fb = retarget(ig, { platform: "facebook" });
    expect(fb.options.location).toBeUndefined();
    expect(fb.options.tagPeople).toBeUndefined();
    expect(fb.options.commentsOff).toBeUndefined();
    // Facebook feed posts cannot show the AI label either.
    expect(fb.options.aiLabel).toBeUndefined();
  });

  it("trims media past the new limit", () => {
    const carousel = { ...emptyState("instagram"), mediaIds: ["a", "b", "c"] };
    expect(retarget(carousel, { kind: "reel" }).mediaIds).toEqual(["a"]);
  });

  it("drops alt text for media that was trimmed", () => {
    const s = {
      ...emptyState("instagram"),
      mediaIds: ["a", "b"],
      altTexts: { a: "first", b: "second" },
    };
    const story = retarget(s, { kind: "story" });
    expect(story.altTexts).toEqual({ a: "first" });
  });

  it("KEEPS the caption even where it will not be shown", () => {
    // Losing what someone typed is worse than carrying it: Story -> post must
    // not silently wipe their words. The Details step just stops showing it.
    const s = { ...emptyState("instagram"), content: "months of work" };
    expect(retarget(s, { kind: "story" }).content).toBe("months of work");
  });
});

describe("blockedReason", () => {
  it("requires media before leaving the Media step", () => {
    expect(blockedReason(emptyState("instagram"), "media", tx)).toMatch(/at least one/i);
  });

  it("clears once media is added", () => {
    const s = { ...emptyState("instagram"), mediaIds: ["a"] };
    expect(blockedReason(s, "media", tx)).toBeNull();
  });

  it("asks a Reel for one video, not 'at least one'", () => {
    const s = { ...emptyState("instagram"), kind: "reel" as const };
    expect(blockedReason(s, "media", tx)).toMatch(/one video/i);
  });
});

describe("publishBody", () => {
  it("sends only the chosen platform", () => {
    const s = { ...emptyState("instagram"), mediaIds: ["m1"], content: "hi" };
    const body = publishBody(s);
    expect(body.channels).toEqual(["instagram"]);
    expect(body).not.toHaveProperty("facebook");
  });

  it("maps commentsOff to Zernio's commentsEnabled:false", () => {
    // The UI asks "turn comments off"; the API field is the inverse. Getting
    // this backwards would silently do nothing.
    const s = { ...emptyState("instagram"), mediaIds: ["m1"], options: { commentsOff: true } };
    expect(publishBody(s).instagram).toMatchObject({ commentsEnabled: false });
  });

  it("omits commentsEnabled entirely when comments stay on", () => {
    const s = { ...emptyState("instagram"), mediaIds: ["m1"], options: {} };
    expect(publishBody(s).instagram).toBeUndefined();
  });

  it("marks a Story with contentType", () => {
    const s = { ...emptyState("instagram"), kind: "story" as const, mediaIds: ["m1"] };
    expect(publishBody(s).instagram).toMatchObject({ contentType: "story" });
  });

  it("names Facebook Reels explicitly, unlike Instagram", () => {
    // Instagram infers a Reel from a single video; Facebook needs telling.
    const fb = { ...emptyState("facebook"), kind: "reel" as const, mediaIds: ["m1"] };
    expect(publishBody(fb).facebook).toMatchObject({ contentType: "reel" });
    const ig = { ...emptyState("instagram"), kind: "reel" as const, mediaIds: ["m1"] };
    expect(publishBody(ig).instagram).toBeUndefined();
  });

  it("never sends an option the platform cannot do, even if state holds it", () => {
    // Belt and braces: retarget should have pruned it, but a stale value must
    // not reach the API if it somehow survives.
    const s = {
      ...emptyState("facebook"),
      mediaIds: ["m1"],
      options: { location: "123", tagPeople: [{ username: "ada" }] },
    };
    const body = publishBody(s);
    expect(body.facebook).toBeUndefined();
  });

  it("sends alt texts positionally, and only when some are set", () => {
    const base = { ...emptyState("instagram"), mediaIds: ["a", "b"] };
    expect(publishBody(base).altTexts).toBeUndefined();
    const withAlt = { ...base, altTexts: { b: "a coffee cup" } };
    expect(publishBody(withAlt).altTexts).toEqual(["", "a coffee cup"]);
  });

  it("carries the schedule with a timezone", () => {
    const when = new Date("2026-12-01T09:00:00Z");
    const s = { ...emptyState("instagram"), mediaIds: ["m1"], scheduledFor: when };
    const body = publishBody(s);
    expect(body.scheduledFor).toBe(when.toISOString());
    expect(body.timezone).toBeTruthy();
  });

  it("sends a Facebook draft flag", () => {
    const s = { ...emptyState("facebook"), mediaIds: ["m1"], asDraft: true };
    expect(publishBody(s).facebook).toMatchObject({ draft: true });
  });
});

describe("activeSettings — what you are about to publish", () => {
  // A Reel went out with comments off and the only way to find out was to
  // open Instagram. These assert the wizard says so first.
  it("is empty when nothing was changed", () => {
    expect(activeSettings(emptyState("instagram"), tx)).toEqual([]);
  });

  it("names comments-off, and marks it as costing something", () => {
    const s = { ...emptyState("instagram"), options: { commentsOff: true } };
    const found = activeSettings(s, tx).find((x) => x.key === "commentsOff");
    expect(found?.label).toMatch(/comments off/i);
    expect(found?.warn).toBe(true);
  });

  it("stays quiet when comments were left alone", () => {
    const s = { ...emptyState("instagram"), options: { commentsOff: undefined } };
    expect(activeSettings(s, tx).some((x) => x.key === "commentsOff")).toBe(false);
  });

  it("reports the AI label, which rides along unnoticed", () => {
    const s = { ...emptyState("instagram"), options: { aiLabel: true } };
    expect(activeSettings(s, tx).some((x) => x.key === "aiLabel")).toBe(true);
  });

  it("only mentions shareToFeed when it was turned OFF", () => {
    const base = { ...emptyState("instagram"), kind: "reel" as const };
    expect(activeSettings({ ...base, options: {} }, tx).some((x) => x.key === "shareToFeed")).toBe(false);
    const off = activeSettings({ ...base, options: { shareToFeed: false } }, tx).find((x) => x.key === "shareToFeed");
    expect(off?.warn).toBe(true);
  });

  it("counts the things that come in multiples", () => {
    const s = {
      ...emptyState("instagram"),
      options: { tagPeople: [{ username: "ada" }, { username: "bob" }], collaborators: ["x"] },
    };
    const labels = activeSettings(s, tx).map((x) => x.label);
    expect(labels).toContain("2 tagged");
    expect(labels).toContain("1 collaborators");
  });

  it("counts alt text from the media it belongs to", () => {
    const s = {
      ...emptyState("instagram"),
      mediaIds: ["a", "b"],
      altTexts: { a: "a cup", b: "   " },
    };
    expect(activeSettings(s, tx).find((x) => x.key === "altText")?.label).toBe("Alt text on 1");
  });

  it("never announces a setting this platform cannot apply", () => {
    // retarget prunes these, but a stale value must not be reported as live.
    const s = { ...emptyState("facebook"), options: { commentsOff: true, location: "123" } };
    expect(activeSettings(s, tx)).toEqual([]);
  });

  it("puts the costly settings last, where the eye lands before the button", () => {
    const s = {
      ...emptyState("instagram"),
      kind: "reel" as const,
      options: { commentsOff: true, aiLabel: true, firstComment: "hi" },
    };
    const list = activeSettings(s, tx);
    expect(list[list.length - 1].key).toBe("commentsOff");
    expect(list.filter((x) => x.warn).length).toBe(1);
  });
});
