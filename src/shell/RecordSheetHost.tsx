import { useCallback, useEffect, useRef, useState } from "react";
import { closeRecordHash, parseRecordParam, type RecordRef } from "@/lib/recordParam";
import { RecordSheet } from "./RecordSheet";

const same = (a: RecordRef | null, b: RecordRef | null): boolean =>
  a === b || (!!a && !!b && a.kind === b.kind && a.id === b.id);

function broadcast(rec: RecordRef): void {
  window.dispatchEvent(new CustomEvent("record:changed", { detail: { kind: rec.kind, id: rec.id } }));
}

/** Mounted once in the shell. The open record lives in the URL
 *  (`#/<route>?record=<kind>:<id>`):
 *  - opening another record assigns the hash, which pushes a history entry, so
 *    Back walks back through every record that was followed and finally closes;
 *  - closing (X, Escape, backdrop) uses replaceState to drop only the record
 *    param, so it adds no history entry and leaves f/cf/v untouched;
 *  - the host owns focus return to whatever opened the sheet. */
export function RecordSheetHost() {
  const [rec, setRec] = useState<RecordRef | null>(() => parseRecordParam(window.location.hash));
  const recRef = useRef(rec);
  recRef.current = rec;
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(rec !== null);

  useEffect(() => {
    const onHash = () => {
      const next = parseRecordParam(window.location.hash);
      if (same(recRef.current, next)) return;
      // Remember the opener before the sheet pulls focus in.
      if (!recRef.current && next) {
        const a = document.activeElement;
        openerRef.current = a instanceof HTMLElement && a !== document.body ? a : null;
      }
      setRec(next);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Return focus to the opener when the sheet closes, however it closes.
  useEffect(() => {
    if (rec) {
      wasOpen.current = true;
      return;
    }
    if (wasOpen.current) {
      wasOpen.current = false;
      const el = openerRef.current;
      openerRef.current = null;
      if (el && el.isConnected) el.focus();
    }
  }, [rec]);

  const close = useCallback(() => {
    const { pathname, search, hash } = window.location;
    const next = closeRecordHash(hash);
    if (next !== hash) window.history.replaceState(null, "", pathname + search + next);
    setRec(null);
  }, []);

  if (!rec) return null;
  return (
    <RecordSheet
      key={`${rec.kind}:${rec.id}`}
      rec={rec}
      onClose={close}
      onChanged={broadcast}
      onDeleted={(r) => {
        close();
        broadcast(r);
      }}
    />
  );
}
