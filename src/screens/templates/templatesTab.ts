export type TemplatesTab = "library" | "quick" | "gallery";

/** SP-17: the tab named by `?tab=` in the hash (`#/templates?tab=gallery`), else the library. */
export function templatesTabFromHash(hash: string): TemplatesTab {
  const query = hash.split("?")[1] ?? "";
  const v = new URLSearchParams(query).get("tab");
  return v === "quick" || v === "gallery" ? v : "library";
}
