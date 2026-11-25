import {
  allowedOriginsFrom,
  frameAncestorsFor,
  isAllowedOrigin,
  normalizeOriginPattern,
  originMatches,
  validateWebchatConfig,
} from "./origin-match";
import { channelErrorKey } from "../channel-errors";

const dev = { production: false };
const prod = { production: true };

describe("origin patterns", () => {
  it.each([
    ["https://shop.example", "https://shop.example"],
    ["HTTPS://Shop.Example", "https://shop.example"],
    ["https://shop.example:8443", "https://shop.example:8443"],
    ["https://shop.example:443", "https://shop.example"],
    ["https://*.shop.com", "https://*.shop.com"],
    ["http://localhost:5173", "http://localhost:5173"],
    ["http://localhost", "http://localhost"],
    ["http://127.0.0.1:8080", "http://127.0.0.1:8080"],
    ["http://localhost:*", "http://localhost:*"],
  ])("dev accepts %s as %s", (raw, want) => {
    expect(normalizeOriginPattern(raw, dev)).toBe(want);
  });

  it.each([
    "*",
    "https://*",
    "https://*.com",
    "*.shop.com",
    "https://a.*.shop.com",
    "https://shop.example/",
    "https://shop.example/path",
    "https://shop.example?x=1",
    "https://user@shop.example",
    "ftp://shop.example",
    "http://shop.example",
    "http://*.localhost",
    "https://shop.example:*",
    "https://shop.example:0",
    "https://shop.example:70000",
    "https://-bad.example",
    "https://shop..example",
    "javascript:alert(1)",
    "",
    "  ",
  ])("dev rejects %j", (raw) => {
    expect(normalizeOriginPattern(raw, dev)).toBeNull();
  });

  it("production is https-only: localhost http is refused", () => {
    expect(normalizeOriginPattern("http://localhost:5173", prod)).toBeNull();
    expect(normalizeOriginPattern("http://localhost:*", prod)).toBeNull();
    expect(normalizeOriginPattern("https://shop.example", prod)).toBe("https://shop.example");
  });

  it("non-strings are rejected", () => {
    expect(normalizeOriginPattern(42 as never, dev)).toBeNull();
    expect(normalizeOriginPattern(null as never, dev)).toBeNull();
  });
});

describe("widget rejects foreign origin (matching)", () => {
  it("a *.shop.com wildcard matches a.shop.com but not shop.com.evil.io", () => {
    expect(originMatches("https://a.shop.com", "https://*.shop.com")).toBe(true);
    expect(originMatches("https://a.b.shop.com", "https://*.shop.com")).toBe(true);
    expect(originMatches("https://shop.com.evil.io", "https://*.shop.com")).toBe(false);
    expect(originMatches("https://shop.com", "https://*.shop.com")).toBe(false);
    expect(originMatches("https://evilshop.com", "https://*.shop.com")).toBe(false);
    expect(originMatches("http://a.shop.com", "https://*.shop.com")).toBe(false);
    expect(originMatches("https://a.shop.com:8443", "https://*.shop.com")).toBe(false);
  });

  it("exact origins compare scheme, host and port", () => {
    expect(originMatches("https://shop.example", "https://shop.example")).toBe(true);
    expect(originMatches("https://shop.example:443", "https://shop.example")).toBe(true);
    expect(originMatches("https://shop.example:8443", "https://shop.example")).toBe(false);
    expect(originMatches("http://shop.example", "https://shop.example")).toBe(false);
    expect(originMatches("https://shop.example.evil.io", "https://shop.example")).toBe(false);
    expect(originMatches("https://shop.example/path", "https://shop.example")).toBe(false);
    expect(originMatches("null", "https://shop.example")).toBe(false);
  });

  it("http://localhost:* matches any localhost port", () => {
    expect(originMatches("http://localhost:3000", "http://localhost:*")).toBe(true);
    expect(originMatches("http://localhost", "http://localhost:*")).toBe(true);
    expect(originMatches("http://localhost.evil.io:3000", "http://localhost:*")).toBe(false);
  });

  it("stored origins are re-validated on read (M2): an http entry stored earlier is ignored in production", () => {
    const config = { allowedOrigins: ["http://localhost:5173", "https://shop.example", "*", 7, "https://x.example/p"] };
    expect(allowedOriginsFrom(config, prod)).toEqual(["https://shop.example"]);
    expect(allowedOriginsFrom(config, dev)).toEqual(["http://localhost:5173", "https://shop.example"]);
    expect(isAllowedOrigin("http://localhost:5173", config, prod)).toBe(false);
    expect(isAllowedOrigin("http://localhost:5173", config, dev)).toBe(true);
    expect(allowedOriginsFrom({ allowedOrigins: "https://shop.example" }, dev)).toEqual([]);
    expect(allowedOriginsFrom(null, dev)).toEqual([]);
  });

  it("frame-ancestors lists the allowed origins, or 'none'", () => {
    expect(frameAncestorsFor(["https://shop.example", "https://*.shop.com"])).toBe("https://shop.example https://*.shop.com");
    expect(frameAncestorsFor([])).toBe("'none'");
  });
});

describe("validateWebchatConfig", () => {
  const bad = (config: Record<string, unknown>, field: string, opts = dev) => {
    let err: unknown;
    try {
      validateWebchatConfig(config, opts);
    } catch (e) {
      err = e;
    }
    expect(channelErrorKey(err)).toBe("channels.invalid_config");
    expect((err as { getResponse(): { field: string } }).getResponse().field).toBe(field);
  };

  it("normalizes and de-duplicates origins and keeps only editable keys", () => {
    const out = validateWebchatConfig(
      {
        allowedOrigins: ["https://Shop.example", "https://shop.example:443", "https://*.shop.com"],
        greeting: "  Hi there  ",
        greetingAr: "مرحبا",
        color: "#12abEF",
        position: "start",
        askName: true,
        lang: "ar",
        botToken: "smuggled",
      },
      dev,
    );
    expect(out).toEqual({
      allowedOrigins: ["https://shop.example", "https://*.shop.com"],
      greeting: "Hi there",
      greetingAr: "مرحبا",
      color: "#12abEF",
      position: "start",
      askName: true,
      lang: "ar",
    });
  });

  it("null clears optional fields", () => {
    expect(validateWebchatConfig({ greeting: null, color: null, lang: null }, dev)).toEqual({ greeting: null, color: null, lang: null });
  });

  it("refuses bad values with the offending field", () => {
    bad({ allowedOrigins: ["*"] }, "allowedOrigins");
    bad({ allowedOrigins: ["http://localhost:5173"] }, "allowedOrigins", prod);
    bad({ allowedOrigins: "https://a.example" }, "allowedOrigins");
    bad({ allowedOrigins: Array.from({ length: 21 }, (_, i) => `https://s${i}.example`) }, "allowedOrigins");
    bad({ greeting: "x".repeat(281) }, "greeting");
    bad({ greetingAr: "x".repeat(281) }, "greetingAr");
    bad({ greeting: 5 }, "greeting");
    bad({ color: "red" }, "color");
    bad({ color: "#fff" }, "color");
    bad({ color: "#12345g" }, "color");
    bad({ position: "middle" }, "position");
    bad({ askName: "yes" }, "askName");
    bad({ lang: "fr" }, "lang");
  });

  it("accepts the 280-character greeting limit exactly", () => {
    expect(validateWebchatConfig({ greeting: "x".repeat(280) }, dev).greeting).toHaveLength(280);
  });
});
