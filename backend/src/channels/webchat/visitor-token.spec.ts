import { isVisitorId, mintVisitor, visitorTokenFor, verifyVisitorToken } from "./visitor-token";

describe("visitor token", () => {
  const OLD = process.env.JWT_SECRET;
  beforeAll(() => {
    process.env.JWT_SECRET = "s".repeat(40);
  });
  afterAll(() => {
    process.env.JWT_SECRET = OLD;
  });

  it("mints a random 128-bit base64url visitor id and a token that verifies for that channel only", () => {
    const a = mintVisitor("ch1");
    const b = mintVisitor("ch1");
    expect(a.visitorId).not.toBe(b.visitorId);
    expect(isVisitorId(a.visitorId)).toBe(true);
    expect(a.visitorId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(verifyVisitorToken("ch1", a.visitorId, a.visitorToken)).toBe(true);
    expect(verifyVisitorToken("ch2", a.visitorId, a.visitorToken)).toBe(false);
    expect(verifyVisitorToken("ch1", b.visitorId, a.visitorToken)).toBe(false);
  });

  it("rejects missing, malformed or tampered tokens", () => {
    const a = mintVisitor("ch1");
    expect(verifyVisitorToken("ch1", a.visitorId, undefined)).toBe(false);
    expect(verifyVisitorToken("ch1", a.visitorId, "")).toBe(false);
    expect(verifyVisitorToken("ch1", a.visitorId, a.visitorToken.slice(1))).toBe(false);
    const flipped = (a.visitorToken[0] === "A" ? "B" : "A") + a.visitorToken.slice(1);
    expect(verifyVisitorToken("ch1", a.visitorId, flipped)).toBe(false);
    expect(verifyVisitorToken("ch1", "not a visitor id!", a.visitorToken)).toBe(false);
    expect(verifyVisitorToken("ch1", a.visitorId, 42 as never)).toBe(false);
  });

  it("depends on the server secret", () => {
    const a = mintVisitor("ch1");
    process.env.JWT_SECRET = "t".repeat(40);
    try {
      expect(verifyVisitorToken("ch1", a.visitorId, a.visitorToken)).toBe(false);
    } finally {
      process.env.JWT_SECRET = "s".repeat(40);
    }
  });

  it("refuses to sign without a strong server secret", () => {
    process.env.JWT_SECRET = "short";
    try {
      expect(() => visitorTokenFor("ch1", "A".repeat(22))).toThrow(/JWT_SECRET/);
    } finally {
      process.env.JWT_SECRET = "s".repeat(40);
    }
  });
});
