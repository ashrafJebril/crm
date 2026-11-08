import { joinName, normalizeDigits, splitName } from "./contact-name";

describe("contact-name", () => {
  it("splitName handles Arabic three-part names", () => {
    expect(splitName("  محمد  أحمد الخطيب ")).toEqual({ firstName: "محمد", lastName: "أحمد الخطيب" });
  });
  it("splitName single word → lastName null", () => {
    expect(splitName("Sara")).toEqual({ firstName: "Sara", lastName: null });
  });
  it("joinName drops empty parts", () => {
    expect(joinName("Sara", " ")).toBe("Sara");
    expect(joinName(null, "Khan")).toBe("Khan");
    expect(joinName("A", "B")).toBe("A B");
  });
  it("normalizeDigits maps Arabic-Indic and Persian digits", () => {
    expect(normalizeDigits("٠١٢٣٤٥٦٧٨٩ ۰۱۲۳۴۵۶۷۸۹ 5")).toBe("0123456789 0123456789 5");
  });
});
