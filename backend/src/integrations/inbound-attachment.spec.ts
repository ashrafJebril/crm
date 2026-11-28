import { inboundMedia } from "./inbound-attachment";

const hex = (s: string) => Buffer.from(s.replace(/\s+/g, ""), "hex");
const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc(Math.max(0, 16 - b.length))]);
const MP4 = pad(Buffer.concat([hex("00000018"), Buffer.from("ftypmp42")]));
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

describe("inboundMedia", () => {
  it("types images and videos from their bytes, whatever the provider said", () => {
    expect(inboundMedia(pad(hex("89504E470D0A1A0A")), "image", "image/jpeg")).toEqual({ mimeType: "image/png", kind: "image" });
    expect(inboundMedia(MP4, "video", "application/octet-stream")).toEqual({ mimeType: "video/mp4", kind: "video" });
  });

  it("reads WhatsApp voice notes and other audio", () => {
    expect(inboundMedia(pad(Buffer.from("OggS")), "audio", "audio/ogg; codecs=opus")).toEqual({ mimeType: "audio/ogg", kind: "audio" });
    expect(inboundMedia(pad(Buffer.from("ID3")), "audio")).toEqual({ mimeType: "audio/mpeg", kind: "audio" });
    expect(inboundMedia(pad(hex("FFFB9000")), undefined)).toEqual({ mimeType: "audio/mpeg", kind: "audio" });
    expect(inboundMedia(pad(hex("FFF15080")), undefined)).toEqual({ mimeType: "audio/aac", kind: "audio" });
    expect(inboundMedia(pad(Buffer.from("#!AMR\n")), "audio")).toEqual({ mimeType: "audio/amr", kind: "audio" });
    expect(inboundMedia(pad(Buffer.from("RIFF\0\0\0\0WAVE")), "audio")).toEqual({ mimeType: "audio/wav", kind: "audio" });
  });

  it("tells an M4A voice note from an MP4 video by the provider's kind or type", () => {
    expect(inboundMedia(MP4, "audio")).toEqual({ mimeType: "audio/mp4", kind: "audio" });
    expect(inboundMedia(MP4, undefined, undefined, "audio/x-m4a")).toEqual({ mimeType: "audio/mp4", kind: "audio" });
    expect(inboundMedia(pad(hex("1A45DFA3")), "audio")).toEqual({ mimeType: "audio/webm", kind: "audio" });
    expect(inboundMedia(pad(hex("1A45DFA3")), "video")).toEqual({ mimeType: "video/webm", kind: "video" });
  });

  it("keeps PDFs and Office files, but only an Office file the provider named", () => {
    expect(inboundMedia(pad(Buffer.from("%PDF-1.7")), "document")).toEqual({ mimeType: "application/pdf", kind: "file" });
    expect(inboundMedia(pad(Buffer.from("PK\x03\x04")), "document", DOCX)).toEqual({ mimeType: DOCX, kind: "file" });
    expect(inboundMedia(pad(Buffer.from("PK\x03\x04")), "document", "application/zip")).toBeNull();
  });

  it("refuses anything else", () => {
    expect(inboundMedia(pad(Buffer.from("<!doctype html>")), "image", "image/jpeg")).toBeNull();
    expect(inboundMedia(pad(Buffer.from("MZ")), "document")).toBeNull();
    expect(inboundMedia(Buffer.alloc(2), "audio")).toBeNull();
  });
});
