import { describe, expect, it } from "vitest";
import { isVideoType, messageBodyView, placeholderKind } from "./messageMedia";

const en = (e: string) => e;
const ar = (_e: string, a: string) => a;

describe("placeholderKind", () => {
  it("recognises the stored media placeholders only", () => {
    expect(placeholderKind("[video]")).toBe("video");
    expect(placeholderKind(" [IMAGE] ")).toBe("image");
    expect(placeholderKind("[audio]")).toBe("audio");
    expect(placeholderKind("look [video]")).toBeNull();
    expect(placeholderKind("")).toBeNull();
    expect(placeholderKind(undefined)).toBeNull();
  });
});

describe("messageBodyView", () => {
  it("keeps ordinary text", () => {
    expect(messageBodyView("سلام عليكم", false, en)).toEqual({ text: "سلام عليكم" });
    expect(messageBodyView("caption", true, en)).toEqual({ text: "caption" });
  });

  it("hides the placeholder when the media renders", () => {
    expect(messageBodyView("[video]", true, en)).toEqual({ text: "" });
  });

  it("labels media that never saved, in both languages", () => {
    expect(messageBodyView("[video]", false, en).missing).toMatch(/Video couldn't be loaded/);
    expect(messageBodyView("[video]", false, ar).missing).toMatch(/تعذّر تحميل الفيديو/);
    expect(messageBodyView("[image]", false, en).missing).toMatch(/Image couldn't be loaded/);
  });
});

describe("isVideoType", () => {
  it("is true only for video/* types", () => {
    expect(isVideoType("video/mp4")).toBe(true);
    expect(isVideoType("Video/QuickTime")).toBe(true);
    expect(isVideoType("image/png")).toBe(false);
    expect(isVideoType("")).toBe(false);
    expect(isVideoType(undefined)).toBe(false);
  });
});
