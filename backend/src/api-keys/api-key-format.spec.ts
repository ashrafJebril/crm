import { createHash } from "crypto";
import { hashApiKey, looksLikeApiKey, newApiKey, parseApiKey, sameHash } from "./api-key-format";

describe("api key format", () => {
  it("newApiKey is crm_<12 hex>_<43 base64url> with a sha256 hash", () => {
    const k = newApiKey();
    expect(k.key).toMatch(/^crm_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
    expect(k.prefix).toBe(k.key.slice(0, 16));
    expect(k.hash).toBe(createHash("sha256").update(k.key).digest("hex"));
    expect(newApiKey().key).not.toBe(k.key);
  });

  it("parseApiKey accepts only well-formed keys", () => {
    const k = newApiKey();
    expect(parseApiKey(k.key)).toEqual({ prefix: k.prefix, hash: k.hash });
    for (const bad of ["", "crm_", "crm_abc", `${k.key}x`, k.key.replace("crm_", "mcp_"), ` ${k.key}`, `crm_ABCDEF012345_${"a".repeat(43)}`]) {
      expect({ bad, parsed: parseApiKey(bad) }).toEqual({ bad, parsed: null });
    }
    expect(looksLikeApiKey(k.key)).toBe(true);
    expect(looksLikeApiKey("eyJhbGciOi")).toBe(false);
    expect(looksLikeApiKey("mcp_x")).toBe(false);
  });

  it("sameHash compares digests in constant time", () => {
    const a = hashApiKey("a");
    expect(sameHash(a, a)).toBe(true);
    expect(sameHash(a, hashApiKey("b"))).toBe(false);
    expect(sameHash(a, a.slice(0, 10))).toBe(false);
    expect(sameHash("", "")).toBe(false);
  });
});
