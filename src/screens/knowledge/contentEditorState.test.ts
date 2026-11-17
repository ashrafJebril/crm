import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { knowledgeExtensions } from "./contentDoc";
import { marksDirty, shouldLoadSaved } from "./contentEditorState";

const DOC = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "We are a salon in Riyadh." }] }] };

/** A headless editor wired like ContentEditor: an update marks it dirty only through marksDirty. */
function headless() {
  let dirty = false;
  let updates = 0;
  const editor = new Editor({
    extensions: knowledgeExtensions(),
    content: { type: "doc", content: [{ type: "paragraph" }] }, // JSON: no DOM needed (the app passes "" in a browser)
    onUpdate: ({ transaction }) => {
      updates += 1;
      if (marksDirty(transaction)) dirty = true;
    },
  });
  return { editor, dirty: () => dirty, updates: () => updates };
}

describe("ContentEditor first load (F6)", () => {
  it("making the editor (non-)editable is not an edit, so the saved content still loads", () => {
    const h = headless();
    // What the editable effect does on mount, before the query resolves.
    h.editor.setEditable(true);
    h.editor.setEditable(false);
    expect(h.updates()).toBe(2); // TipTap does emit "update" for these
    expect(h.dirty()).toBe(false);
    // The data arrives: it loads because nothing is dirty.
    expect(shouldLoadSaved({ ready: true, dirty: h.dirty(), loadedVersion: null, version: 1 })).toBe(true);
    h.editor.commands.setContent(DOC, { emitUpdate: false });
    expect(h.editor.getText()).toBe("We are a salon in Riyadh.");
    expect(h.dirty()).toBe(false);
    h.editor.destroy();
  });

  it("a real document change is an edit", () => {
    const h = headless();
    h.editor.commands.setContent(DOC, { emitUpdate: true });
    expect(h.dirty()).toBe(true);
    h.editor.destroy();
  });

  it("loads once per version and never over unsaved edits", () => {
    expect(shouldLoadSaved({ ready: false, dirty: false, loadedVersion: null, version: 0 })).toBe(false);
    expect(shouldLoadSaved({ ready: true, dirty: false, loadedVersion: null, version: 0 })).toBe(true); // no content yet: still marks it loaded
    expect(shouldLoadSaved({ ready: true, dirty: false, loadedVersion: 3, version: 3 })).toBe(false);
    expect(shouldLoadSaved({ ready: true, dirty: false, loadedVersion: 3, version: 4 })).toBe(true);
    expect(shouldLoadSaved({ ready: true, dirty: true, loadedVersion: 3, version: 4 })).toBe(false);
  });
});
