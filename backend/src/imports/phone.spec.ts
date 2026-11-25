import { countryCodeForTimezone, normalizeImportPhone } from "./phone";

describe("normalizeImportPhone", () => {
  it("accepts +CC, 00CC and local 0… (Dubai) as the same number", () => {
    expect(normalizeImportPhone("+971501234567", "971")).toBe("+971501234567");
    expect(normalizeImportPhone("00971501234567", "971")).toBe("+971501234567");
    expect(normalizeImportPhone("0501234567", "971")).toBe("+971501234567");
  });

  it("normalizes Arabic-Indic digits first", () => {
    expect(normalizeImportPhone("٠٥٠١٢٣٤٥٦٧", "971")).toBe("+971501234567");
    expect(normalizeImportPhone("+٩٧١٥٠١٢٣٤٥٦٧")).toBe("+971501234567");
  });

  it("strips spaces, dashes, dots and parentheses", () => {
    expect(normalizeImportPhone("+971 (50) 123-4567")).toBe("+971501234567");
    expect(normalizeImportPhone("050.123.4567", "971")).toBe("+971501234567");
  });

  it("rejects a local number without a default country code", () => {
    expect(normalizeImportPhone("0501234567")).toBeNull();
    expect(normalizeImportPhone("0501234567", null as any)).toBeNull();
  });

  it("rejects empty, too short, too long and non-numeric input", () => {
    expect(normalizeImportPhone("")).toBeNull();
    expect(normalizeImportPhone("   ")).toBeNull();
    expect(normalizeImportPhone("abc")).toBeNull();
    expect(normalizeImportPhone("+12345")).toBeNull();
    expect(normalizeImportPhone("+1234567890123456")).toBeNull();
  });

  it("accepts bare digits that already start with the default country code", () => {
    expect(normalizeImportPhone("971501234567", "971")).toBe("+971501234567");
    expect(normalizeImportPhone("971501234567")).toBeNull();
    expect(normalizeImportPhone("966501234567", "971")).toBeNull();
  });

  it("rejects a leading 0 after the prefix and drops a kept trunk zero", () => {
    expect(normalizeImportPhone("+0501234567", "971")).toBeNull();
    expect(normalizeImportPhone("000501234567", "971")).toBeNull();
    expect(normalizeImportPhone("+971 0501234567", "971")).toBe("+971501234567");
    expect(normalizeImportPhone("00971 0501234567", "971")).toBe("+971501234567");
    expect(normalizeImportPhone("9710501234567", "971")).toBe("+971501234567");
  });

  it("rejects input containing letters", () => {
    expect(normalizeImportPhone("0501234567 ext 12", "971")).toBeNull();
    expect(normalizeImportPhone("+971501234567x", "971")).toBeNull();
  });

  it("rejects a bare number with no prefix and no leading 0", () => {
    expect(normalizeImportPhone("501234567", "971")).toBeNull();
  });
});

describe("countryCodeForTimezone", () => {
  it.each([
    ["Asia/Dubai", "971"],
    ["Asia/Riyadh", "966"],
    ["Asia/Amman", "962"],
    ["Asia/Kuwait", "965"],
    ["Asia/Qatar", "974"],
    ["Asia/Bahrain", "973"],
    ["Asia/Muscat", "968"],
    ["Africa/Cairo", "20"],
  ])("%s -> %s", (tz, cc) => {
    expect(countryCodeForTimezone(tz)).toBe(cc);
  });

  it("returns null for unknown or missing timezones", () => {
    expect(countryCodeForTimezone("Europe/Paris")).toBeNull();
    expect(countryCodeForTimezone("")).toBeNull();
    expect(countryCodeForTimezone(null)).toBeNull();
  });
});
