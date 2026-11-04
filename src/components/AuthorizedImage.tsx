import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { IconAlert } from "@/icons";
import { loadMedia, MediaFetchError } from "@/lib/mediaFetch";

type State = { kind: "waiting" } | { kind: "loaded"; src: string } | { kind: "error"; missing: boolean };

const IMG_STYLE: CSSProperties = { width: "100%", height: "100%", objectFit: "cover", display: "block" };

/**
 * Thumbnail for a protected /media/:id/file URL. <img> can't send the bearer
 * token, so the file is fetched (through the shared, rate-limited queue) and
 * shown as a blob URL. Loading starts only once the tile is near the viewport.
 */
export function AuthorizedImage({
  url,
  alt,
  token,
  retryable = true,
}: {
  url: string;
  alt: string;
  token: string | null;
  /** Show a Retry button on failure. Off when the tile itself is a button. */
  retryable?: boolean;
}) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const ref = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<State>({ kind: "waiting" });

  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setVisible(true);
      },
      { rootMargin: "300px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const ctrl = new AbortController();
    let objectUrl: string | null = null;
    setState({ kind: "waiting" });
    loadMedia(url, token, ctrl.signal)
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        setState({ kind: "loaded", src: objectUrl });
      })
      .catch((e) => {
        if (ctrl.signal.aborted) return;
        setState({ kind: "error", missing: e instanceof MediaFetchError && e.status === 404 });
      });
    return () => {
      ctrl.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [visible, url, token, attempt]);

  if (state.kind === "loaded") return <img src={state.src} alt={alt} style={IMG_STYLE} />;

  return (
    <div
      ref={ref}
      aria-busy={state.kind === "waiting"}
      style={{ width: "100%", height: "100%", display: "grid", placeItems: "center", padding: 8 }}
    >
      {state.kind === "waiting" ? (
        <div
          aria-label={tx("Loading image", "جارٍ تحميل الصورة")}
          style={{ width: "100%", height: "100%", borderRadius: 6, background: "var(--bg-3)", animation: "pulse 1.4s ease-in-out infinite" }}
        />
      ) : (
        <div style={{ display: "grid", justifyItems: "center", gap: 6, textAlign: "center", color: "var(--ink-3)", fontSize: 11 }}>
          <IconAlert w={16} />
          <span>{state.missing ? tx("File missing", "الملف غير موجود") : tx("Couldn't load", "تعذّر التحميل")}</span>
          {retryable && !state.missing && (
            <button type="button" className="btn sm" onClick={() => setAttempt((n) => n + 1)}>
              {tx("Retry", "إعادة المحاولة")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
