import { describe, expect, it } from "vitest";
import { attachmentView, fileLabel, messageBodyView, opensInBrowser, placeholderKind } from "./messageMedia";

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

describe("attachmentView", () => {
  it("plays video and audio, shows images, and treats the rest as files", () => {
    expect(attachmentView("Video/QuickTime")).toBe("video");
    expect(attachmentView("audio/ogg")).toBe("audio");
    expect(attachmentView("audio/mp4")).toBe("audio");
    expect(attachmentView("image/png")).toBe("image");
    expect(attachmentView("application/pdf")).toBe("file");
    expect(attachmentView("")).toBe("file");
    expect(attachmentView(undefined)).toBe("file");
  });
});

describe("fileLabel and opensInBrowser", () => {
  const tx = (en: string) => en;
  it("names common documents and opens only PDFs in the browser", () => {
    expect(fileLabel("application/pdf", tx)).toBe("PDF");
    expect(fileLabel("application/vnd.openxmlformats-officedocument.wordprocessingml.document", tx)).toBe("Word");
    expect(fileLabel("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", tx)).toBe("Excel");
    expect(fileLabel("application/zip", tx)).toBe("File");
    expect(opensInBrowser("application/pdf")).toBe(true);
    expect(opensInBrowser("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(false);
  });
});

describe("placeholderKind aliases", () => {
  it("reads Zernio's document and sticker kinds", () => {
    expect(placeholderKind("[document]")).toBe("file");
    expect(placeholderKind("[sticker]")).toBe("image");
  });
});
