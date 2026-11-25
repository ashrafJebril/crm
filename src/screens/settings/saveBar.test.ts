import { describe, expect, it } from "vitest";
import { isDirty, patchOf, saveBarState, type GeneralForm } from "./saveBar";

const initial: GeneralForm = { name: "Salon Noor", timezone: "Asia/Riyadh", lang: "ar", brandColor: "#abcdef" };
const at = (f: Partial<GeneralForm>): GeneralForm => ({ ...initial, ...f });
const state = (o: Partial<Parameters<typeof saveBarState>[0]>) => saveBarState({ dirty: false, saving: false, error: null, savedAt: null, now: 10_000, ...o });

describe("save bar appears only when dirty", () => {
  it("clean, edited, edited back, saving, saved for 2 s, read-only", () => {
    expect(state({ dirty: isDirty(initial, initial) })).toBe("hidden");
    expect(state({ dirty: isDirty(at({ name: "Salon" }), initial) })).toBe("dirty");
    // Back to the original, including whitespace and colour case.
    expect(isDirty(at({ name: "  Salon Noor " }), initial)).toBe(false);
    expect(isDirty(at({ brandColor: "#ABCDEF" }), initial)).toBe(false);
    expect(isDirty(at({ brandColor: "#ABC" }), at({ brandColor: "#aabbcc" }))).toBe(false);
    expect(state({ dirty: false })).toBe("hidden");
    expect(state({ dirty: true, saving: true })).toBe("saving");
    expect(state({ savedAt: 9_000, now: 10_000 })).toBe("saved");
    expect(state({ savedAt: 7_999, now: 10_000 })).toBe("hidden");
    for (const s of [{ dirty: true }, { saving: true }, { dirty: true, error: "x" }, { savedAt: 9_999 }]) {
      expect(state({ ...s, readOnly: true })).toBe("hidden");
    }
  });

  it("an invalid colour counts as a change (Save then shows the error)", () => {
    expect(isDirty(at({ brandColor: "red" }), initial)).toBe(true);
  });

  it("the patch carries only what changed, normalised", () => {
    expect(patchOf(at({ name: " Salon ", brandColor: "#ABC" }), initial)).toEqual({ name: "Salon", brandColor: "#aabbcc" });
    expect(patchOf(at({ brandColor: "" }), initial)).toEqual({ brandColor: null });
    expect(patchOf(initial, initial)).toEqual({});
  });
});

describe("save error keeps edits and shows error state", () => {
  it("error with a dirty form → error; after Discard → hidden", () => {
    const edited = at({ name: "New name" });
    expect(state({ dirty: isDirty(edited, initial), error: "Couldn't save." })).toBe("error");
    // Discard resets the form to the initial values.
    expect(state({ dirty: isDirty(initial, initial), error: null })).toBe("hidden");
  });
});
