import { useEffect, useRef } from "react";
import { api } from "@/api/client";

/** Notes already reported as seen this session (one POST per note, shared by
 *  every surface that shows notes). */
const seenSent = new Set<string>();

/** Reports a note as seen once its element scrolls into view. */
export function useSeenOnView(noteId: string, skip: boolean) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || skip || seenSent.has(noteId)) return;
    if (typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting) || seenSent.has(noteId)) return;
      seenSent.add(noteId);
      io.disconnect();
      api.post(`/notes/${noteId}/seen`, {}).catch(() => seenSent.delete(noteId));
    });
    io.observe(el);
    return () => io.disconnect();
  }, [noteId, skip]);
  return ref;
}
