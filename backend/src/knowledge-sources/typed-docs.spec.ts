import { normalizeHeader, parseTypedDate, typedRowText, validateTypedSheet, TYPED_COLUMNS } from "./typed-docs";
import { MAX_ROW_ERRORS_REPORTED, MAX_TYPED_ROWS } from "./knowledge-constants";

const INV_HEADERS = ["Product Name", "SKU", "price", "currency", "In Stock", "image_url"];
const invRow = (name: string, price: string, extra: Partial<Record<"sku" | "currency" | "stock" | "img", string>> = {}) => [
  name,
  extra.sku ?? "",
  price,
  extra.currency ?? "",
  extra.stock ?? "",
  extra.img ?? "",
];

describe("typed docs", () => {
  it("typed doc rejects wrong template columns with row errors", () => {
    // Offers without valid_to: refused with the column report.
    const offers = validateTypedSheet("offers", ["Offer Name", "price", "Notes", "colour"], [["Eid", "10", "", ""]], [2]);
    expect(offers).toMatchObject({ ok: false, missing: ["valid_to"], unknown: ["notes", "colour"], rows: [] });

    // Inventory: row 4 has a non-number price, row 7 an empty product_name.
    const rows = [invRow("Shampoo", "25"), invRow("Conditioner", "30"), invRow("Mask", "abc"), invRow("Oil", "12"), invRow("Serum", "40"), invRow("", "15")];
    const v = validateTypedSheet("inventory", INV_HEADERS, rows, [2, 3, 4, 5, 6, 7]);
    expect(v.ok).toBe(false);
    expect(v.missing).toEqual([]);
    expect(v.rowErrors).toEqual([
      { row: 4, column: "price", error: "number" },
      { row: 7, column: "product_name", error: "required" },
    ]);
    expect(v.total).toBe(2);
    // The good rows are kept, with the workspace currency defaulted.
    expect(v.rows.map((r) => r.row)).toEqual([2, 3, 5, 6]);
    expect(v.rows[0].values).toEqual({ product_name: "Shampoo", price: "25", currency: "SAR" });
  });

  it("checks every rule: numbers, dates, booleans, currency, https urls", () => {
    const v = validateTypedSheet(
      "inventory",
      INV_HEADERS,
      [
        invRow("A", "-1"),
        invRow("B", "1,250.5", { stock: "نعم", currency: "usd", img: "https://cdn.example/a.png" }),
        invRow("C", "1", { stock: "maybe" }),
        invRow("D", "1", { currency: "riyal" }),
        invRow("E", "1", { img: "http://cdn.example/a.png" }),
        invRow("F", "1", { img: "javascript:alert(1)" }),
      ],
      [2, 3, 4, 5, 6, 7],
      { defaultCurrency: "AED" },
    );
    expect(v.rowErrors).toEqual([
      { row: 2, column: "price", error: "number" },
      { row: 4, column: "in_stock", error: "boolean" },
      { row: 5, column: "currency", error: "currency" },
      { row: 6, column: "image_url", error: "url" },
      { row: 7, column: "image_url", error: "url" },
    ]);
    expect(v.rows).toEqual([
      { row: 3, values: { product_name: "B", price: "1250.5", currency: "USD", in_stock: "yes", image_url: "https://cdn.example/a.png" }, validTo: null },
    ]);

    expect(parseTypedDate("2026-12-31")).toBe("2026-12-31");
    expect(parseTypedDate("31/12/2026")).toBe("2026-12-31");
    expect(parseTypedDate("46022")).toBe("2025-12-31");
    expect(parseTypedDate("2026-02-30")).toBeNull();
    expect(parseTypedDate("next week")).toBeNull();
    const offers = validateTypedSheet("offers", ["offer_name", "valid_to"], [["Eid", "31/12/2026"], ["Bad", "soon"]], [2, 3]);
    expect(offers.rows).toEqual([{ row: 2, values: { offer_name: "Eid", valid_to: "2026-12-31" }, validTo: "2026-12-31" }]);
    expect(offers.rowErrors).toEqual([{ row: 3, column: "valid_to", error: "date" }]);
  });

  it("typed rows over 2000 are refused", () => {
    const rows = Array.from({ length: MAX_TYPED_ROWS + 1 }, (_, i) => [`p${i}`, "1"]);
    const v = validateTypedSheet("inventory", ["product_name", "price"], rows, rows.map((_, i) => i + 2));
    expect(v).toMatchObject({ ok: false, rowErrors: [{ row: null, column: null, error: "too_many_rows" }], total: 1, rows: [] });
    const exactly = validateTypedSheet("inventory", ["product_name", "price"], rows.slice(1), rows.slice(1).map((_, i) => i + 2));
    expect(exactly.ok).toBe(true);
  });

  it("reports at most 100 row errors but counts them all", () => {
    const rows = Array.from({ length: 150 }, () => ["", "x"]);
    const v = validateTypedSheet("inventory", ["product_name", "price"], rows, rows.map((_, i) => i + 2));
    expect(v.rowErrors).toHaveLength(MAX_ROW_ERRORS_REPORTED);
    expect(v.total).toBe(300);
  });

  it("headers match case-insensitively with spaces as underscores, and rows render in column order", () => {
    expect(normalizeHeader("  Valid To* ")).toBe("valid_to");
    expect(TYPED_COLUMNS.packages.filter((c) => c.required).map((c) => c.name)).toEqual(["package_name", "includes", "price"]);
    const v = validateTypedSheet("packages", ["PRICE", "Includes", "Package Name"], [["300", "Cut + color", "Gold"]], [2]);
    expect(typedRowText("packages", v.rows[0])).toBe("package_name: Gold; includes: Cut + color; price: 300; currency: SAR");
  });
});
