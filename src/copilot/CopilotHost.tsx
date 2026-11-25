import { lazy, Suspense, useEffect, useState } from "react";
import { OPEN_COPILOT_EVENT, useCopilotAvailable } from "./copilotApi";
import { isShortcut, shortcutAllowed } from "./drawerKeys";

// The drawer (TipTap and all) loads on first open, not with the app shell.
const CopilotDrawer = lazy(() => import("./CopilotDrawer"));

/**
 * SP-18: listens for "open the copilot" (Topbar button, ask boxes) and
 * Ctrl/Cmd+J. Nothing renders while `GET /copilot/status` says unavailable.
 * Once opened, the drawer stays mounted (hidden when closed) so a running
 * turn keeps streaming into it and the composer keeps its draft.
 */
export function CopilotHost() {
  const available = useCopilotAvailable();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [prompt, setPrompt] = useState<{ text: string; n: number } | null>(null);
  const [session, setSession] = useState<{ id: string; n: number } | null>(null);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<{ prompt?: string; sessionId?: string }>).detail ?? {};
      setOpen(true);
      setLoaded(true);
      if (d.prompt) setPrompt((x) => ({ text: d.prompt!, n: (x?.n ?? 0) + 1 }));
      if (d.sessionId) setSession((x) => ({ id: d.sessionId!, n: (x?.n ?? 0) + 1 }));
    };
    const onKey = (e: KeyboardEvent) => {
      // Not while typing in a field outside the drawer (the field keeps its own keys).
      if (isShortcut(e) && shortcutAllowed(e.target as HTMLElement | null)) {
        e.preventDefault();
        setLoaded(true);
        setOpen((o) => !o);
      }
    };
    window.addEventListener(OPEN_COPILOT_EVENT, onOpen);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener(OPEN_COPILOT_EVENT, onOpen);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  if (!available || !loaded) return null;
  return (
    <Suspense fallback={null}>
      <CopilotDrawer open={open} onClose={() => setOpen(false)} prompt={prompt} session={session} />
    </Suspense>
  );
}
