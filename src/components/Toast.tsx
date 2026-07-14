import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

type ToastKind = "info" | "error" | "success";
interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
}

interface ToastApi {
  toast: (message: string, kind?: ToastKind) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/**
 * App-wide toast host. Replaces the scattered `alert(...)` error dialogs and
 * ad-hoc `setStatus(...) + setTimeout` banners with one styled, non-blocking
 * notifier. Mount <ToastProvider> once near the app root; call `useToast()`
 * anywhere below it.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const toast = useCallback((message: string, kind: ToastKind = "info") => {
    const id = ++seq.current;
    setItems((prev) => [...prev, { id, message, kind }]);
    window.setTimeout(() => {
      setItems((prev) => prev.filter((t) => t.id !== id));
    }, 3200);
  }, []);

  const api = useMemo<ToastApi>(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        style={{
          position: "fixed",
          bottom: 20,
          insetInlineEnd: 20,
          display: "flex",
          flexDirection: "column",
          gap: 8,
          zIndex: 2147483647,
          pointerEvents: "none",
        }}
      >
        {items.map((t) => (
          <div
            key={t.id}
            style={{
              minWidth: 220,
              maxWidth: 360,
              padding: "10px 14px",
              borderRadius: 10,
              fontSize: 13,
              color: "var(--ink)",
              background: "var(--bg-elev, var(--bg-1))",
              border: `1px solid ${
                t.kind === "error"
                  ? "var(--bad)"
                  : t.kind === "success"
                    ? "var(--ok)"
                    : "var(--line)"
              }`,
              boxShadow: "var(--shadow-lg, 0 8px 30px rgba(0,0,0,0.25))",
              borderInlineStartWidth: 3,
              borderInlineStartColor:
                t.kind === "error"
                  ? "var(--bad)"
                  : t.kind === "success"
                    ? "var(--ok)"
                    : "var(--accent)",
            }}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  // Fallback so a component works even if the provider isn't mounted (e.g. in
  // isolated tests) — degrades to console instead of throwing.
  if (!ctx) {
    return {
      toast: (m: string) => {
        // eslint-disable-next-line no-console
        console.warn("[toast]", m);
      },
    };
  }
  return ctx;
}
