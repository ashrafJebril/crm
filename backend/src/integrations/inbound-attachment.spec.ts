import { inboundAttachmentMime } from "./inbound-attachment";

describe("inboundAttachmentMime", () => {
  it("prefers the payload's image/video type, then the header's", () => {
    expect(inboundAttachmentMime("video", "video/quicktime", "video/mp4")).toBe("video/quicktime");
    expect(inboundAttachmentMime("video", undefined, "video/mp4")).toBe("video/mp4");
    expect(inboundAttachmentMime("image", "", "IMAGE/PNG")).toBe("image/png");
  });

  it("ignores non-media types and falls back by attachment kind", () => {
    expect(inboundAttachmentMime("video", undefined, "application/octet-stream")).toBe("video/mp4");
    expect(inboundAttachmentMime("image", "application/json", "")).toBe("image/jpeg");
    expect(inboundAttachmentMime(undefined, undefined, undefined)).toBe("image/jpeg");
  });
});
