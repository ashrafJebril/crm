/** Characters that make spreadsheet apps read a cell as a formula. */
const TRIGGERS = new Set(["=", "+", "-", "@", "\t", "\r"]);

/** Export side: neutralise a would-be formula with a leading apostrophe. */
export function escapeFormulaCell(v: string): string {
  return v.length > 0 && TRIGGERS.has(v[0]) ? `'${v}` : v;
}

/** Import side: inverse of escapeFormulaCell (strip ' only before a trigger char). */
export function unescapeFormulaCell(v: string): string {
  return v.length > 1 && v[0] === "'" && TRIGGERS.has(v[1]) ? v.slice(1) : v;
}
