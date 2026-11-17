import { lazy, Suspense, useEffect, useState } from "react";
import { OPEN_COPILOT_EVENT, useCopilotAvailable } from "./copilotApi";

// The drawer (TipTap and all) loads on first open, not with the app shell.
const CopilotDrawer = lazy(() => import("./CopilotDrawer"));

/**
 * SP-18: listens for "open the copilot" (Topbar button, ask boxes) and
 * Ctrl/Cmd+J. Nothing renders while `GET /copilot/status` says unavailable.
 * Once opened, the drawer stays mounted (hidden when closed) so a running
 * turn keeps streaming into it.
 */
export function CopilotHost() {
  const available = useCopilotAvailable();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [prompt, setPrompt] = useState<{ text: string; n: number } | null>(null);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const p = (e as CustomEvent<{ prompt?: string }>).detail?.prompt;
      setOpen(true);
      setLoaded(true);
      if (p) setPrompt((x) => ({ text: p, n: (x?.n ?? 0) + 1 }));
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "j") {
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
      <CopilotDrawer open={open} onClose={() => setOpen(false)} prompt={prompt} />
    </Suspense>
  );
}
