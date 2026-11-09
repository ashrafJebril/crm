import { describe, expect, it } from "vitest";
import { pickSendRoute, supportsTemplates } from "./sendRoute";

const c = (channel: string, channelProvider?: string | null) => ({ channel, channelProvider }) as any;

describe("pickSendRoute", () => {
  it("send route chosen by channelProvider", () => {
    expect(pickSendRoute(c("telegram", "telegram"), false)).toBe("native");
    expect(pickSendRoute(c("webchat", "native"), false)).toBe("native");
    expect(pickSendRoute(c("whatsapp", "zernio"), false)).toBe("zernio");
    expect(pickSendRoute(c("instagram", "zernio"), false)).toBe("zernio");
    expect(pickSendRoute(c("whatsapp", "meta"), true)).toBe("meta_wa");
    expect(pickSendRoute(c("instagram", "meta"), true)).toBe("meta_ig");
  });
  it("the provider wins over the Zernio status guess", () => {
    expect(pickSendRoute(c("whatsapp", "meta"), true)).toBe("meta_wa");
    expect(pickSendRoute(c("telegram", "telegram"), true)).toBe("native");
  });
  it("falls back to the Zernio guess only when the provider is missing", () => {
    expect(pickSendRoute(c("whatsapp", null), true)).toBe("zernio");
    expect(pickSendRoute(c("whatsapp", null), false)).toBe("meta_wa");
    expect(pickSendRoute(c("instagram", undefined), false)).toBe("meta_ig");
    expect(pickSendRoute(c("webchat", null), false)).toBe("legacy");
    expect(pickSendRoute(c("whatsapp", "kapso"), false)).toBe("meta_wa");
  });
  it("hides templates for telegram and webchat", () => {
    expect(supportsTemplates(c("telegram", "telegram"))).toBe(false);
    expect(supportsTemplates(c("webchat", "native"))).toBe(false);
    expect(supportsTemplates(c("whatsapp", "zernio"))).toBe(true);
  });
});
