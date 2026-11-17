/**
 * SP-21 ContentEditor load rules (F6), pure so they are testable without a DOM.
 *
 * TipTap emits "update" for setEditable() too (an empty transaction), which
 * used to mark the editor dirty on mount, before the saved content arrived; the
 * load then skipped "over unsaved edits" and the editor stayed empty until a
 * remount. Only a transaction that changes the document is an edit.
 */
export function marksDirty(transaction: { docChanged: boolean }): boolean {
  return transaction.docChanged;
}

/** Put the saved version in the editor: once the data is there, once per version, never over unsaved edits. */
export function shouldLoadSaved(s: { ready: boolean; dirty: boolean; loadedVersion: number | null; version: number }): boolean {
  if (!s.ready || s.dirty) return false;
  return s.loadedVersion !== s.version;
}
