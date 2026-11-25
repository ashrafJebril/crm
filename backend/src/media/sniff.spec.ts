import { familyOfMime, sniffFamily, SNIFF_BYTES } from "./sniff";

const hex = (s: string) => Buffer.from(s.replace(/\s+/g, ""), "hex");
const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc(Math.max(0, SNIFF_BYTES - b.length))]);

describe("sniffFamily", () => {
  it("recognises each library family by its magic bytes", () => {
    expect(sniffFamily(pad(hex("FFD8FFE0")))).toBe("jpeg");
    expect(sniffFamily(pad(hex("89504E470D0A1A0A")))).toBe("png");
    expect(sniffFamily(pad(Buffer.from("GIF89a")))).toBe("gif");
    expect(sniffFamily(pad(Buffer.from("GIF87a")))).toBe("gif");
    expect(sniffFamily(Buffer.concat([Buffer.from("RIFF"), hex("00000000"), Buffer.from("WEBPVP8 ")]))).toBe("webp");
    expect(sniffFamily(pad(Buffer.concat([hex("00000018"), Buffer.from("ftypmp42")])))).toBe("mp4");
    expect(sniffFamily(pad(Buffer.concat([hex("00000014"), Buffer.from("ftypqt  ")])))).toBe("mp4");
    expect(sniffFamily(pad(Buffer.from("%PDF-1.7\n")))).toBe("pdf");
  });

  it("returns null for anything else, including short, empty, HTML and SVG input", () => {
    expect(sniffFamily(Buffer.alloc(0))).toBeNull();
    expect(sniffFamily(hex("FFD8"))).toBeNull();
    expect(sniffFamily(pad(Buffer.from("<!doctype html>")))).toBeNull();
    expect(sniffFamily(pad(Buffer.from("<svg xmlns=")))).toBeNull();
    expect(sniffFamily(pad(Buffer.from("RIFF\0\0\0\0WAVE")))).toBeNull();
    expect(sniffFamily(pad(Buffer.from("PK\x03\x04")))).toBeNull();
  });
});

describe("familyOfMime", () => {
  it("maps the declared library mime types to a family", () => {
    expect(familyOfMime("image/jpeg")).toBe("jpeg");
    expect(familyOfMime("image/png")).toBe("png");
    expect(familyOfMime("image/gif")).toBe("gif");
    expect(familyOfMime("image/webp")).toBe("webp");
    expect(familyOfMime("video/mp4")).toBe("mp4");
    expect(familyOfMime("video/quicktime")).toBe("mp4");
    expect(familyOfMime("application/pdf")).toBe("pdf");
    expect(familyOfMime("IMAGE/PNG")).toBe("png");
  });

  it("returns null for types outside the library", () => {
    expect(familyOfMime("image/svg+xml")).toBeNull();
    expect(familyOfMime("text/html")).toBeNull();
    expect(familyOfMime("text/csv")).toBeNull();
    expect(familyOfMime("")).toBeNull();
  });
});
