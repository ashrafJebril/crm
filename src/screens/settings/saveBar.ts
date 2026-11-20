/**
 * SP-29 sticky save bar (pure). The bar appears only when the form differs
 * from what is saved (normalised: trimmed name, colour lower-cased), stays
 * with the edits on an error, shows "Saved" for SAVED_FLASH_MS, and never
 * renders read-only.
 */
import { normalizeBrandColor } from "@/lib/brandColor";
import { SAVED_FLASH_MS } from "./brand";

export interface GeneralForm {
  name: string;
  timezone: string;
  lang: string;
  /** The text field's value ("" = no colour). */
  brandColor: string;
}

export type SaveBarState = "hidden" | "dirty" | "saving" | "saved" | "error";

/** The comparable form: trimmed name; the colour normalised (an invalid colour stays as typed, so it counts as a change). */
export function normalizeForm(f: GeneralForm): GeneralForm {
  const c = normalizeBrandColor(f.brandColor);
  return {
    name: f.name.trim(),
    timezone: f.timezone,
    lang: f.lang,
    brandColor: c === undefined ? f.brandColor.trim() : c ?? "",
  };
}

export function isDirty(form: GeneralForm, initial: GeneralForm): boolean {
  return JSON.stringify(normalizeForm(form)) !== JSON.stringify(normalizeForm(initial));
}

export function saveBarState(s: { dirty: boolean; saving: boolean; error: string | null; savedAt: number | null; now: number; readOnly?: boolean }): SaveBarState {
  if (s.readOnly) return "hidden";
  if (s.saving) return "saving";
  if (s.error && s.dirty) return "error";
  if (s.dirty) return "dirty";
  if (s.savedAt !== null && s.now - s.savedAt < SAVED_FLASH_MS) return "saved";
  return "hidden";
}

/** The PATCH body: only what changed, normalised (null clears the colour). */
export function patchOf(form: GeneralForm, initial: GeneralForm): Record<string, string | null> {
  const f = normalizeForm(form);
  const i = normalizeForm(initial);
  const out: Record<string, string | null> = {};
  if (f.name !== i.name) out.name = f.name;
  if (f.timezone !== i.timezone) out.timezone = f.timezone;
  if (f.lang !== i.lang) out.lang = f.lang;
  if (f.brandColor !== i.brandColor) out.brandColor = f.brandColor === "" ? null : f.brandColor;
  return out;
}
