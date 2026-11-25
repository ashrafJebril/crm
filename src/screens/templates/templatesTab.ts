export type TemplatesTab = "library" | "quick" | "gallery";

/** SP-17: the tab named by a `?tab=` value; anything else is the library. */
export function templatesTabFromParam(v: string | null | undefined): TemplatesTab {
  return v === "quick" || v === "gallery" ? v : "library";
}

/** The tab named by `?tab=` in the hash (`#/templates?tab=gallery`), else the library. */
export function templatesTabFromHash(hash: string): TemplatesTab {
  const query = hash.split("?")[1] ?? "";
  return templatesTabFromParam(new URLSearchParams(query).get("tab"));
}

/** The `?tab=` value to write for a tab: none for the default library, so `#/templates` stays clean. */
export const templatesTabParam = (tab: TemplatesTab): string | null => (tab === "library" ? null : tab);
