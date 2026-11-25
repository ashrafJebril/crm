import { describe, expect, it } from "vitest";
import { channelLabel, displaySubtitle, formatDate } from "./recordFields";

describe("displaySubtitle", () => {
  it("translates channels for conversations and campaigns", () => {
    expect(displaySubtitle("conversation", "whatsapp", undefined, "ar")).toBe("واتساب");
    expect(displaySubtitle("campaign", "Broadcast", undefined, "en")).toBe("Broadcast");
    expect(channelLabel("unknown", "en")).toBe("unknown");
  });
  it("formats booking dates and falls back to the raw text", () => {
    expect(displaySubtitle("booking", "2026-11-09T10:00:00.000Z", undefined, "en")).not.toContain("T10:00");
    expect(formatDate("not a date", "en")).toBe("not a date");
  });
  it("prefers the Arabic subtitle and keeps server text otherwise", () => {
    expect(displaySubtitle("ticket", "Won", "مكسب", "ar")).toBe("مكسب");
    expect(displaySubtitle("ticket", "Won", "مكسب", "en")).toBe("Won");
    expect(displaySubtitle("contact", undefined, undefined, "en")).toBe("");
  });
});
