import { useEffect, useState, type CSSProperties } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { IconAlert } from "@/icons";
import { loadMedia, MediaFetchError } from "@/lib/mediaFetch";

type State = { kind: "waiting" } | { kind: "loaded"; src: string } | { kind: "error"; missing: boolean };

/**
 * Playable video for a protected /media/:id/file URL.
 *
 * The sibling of AuthorizedImage, and it exists for the same reason: a
 * <video src> tag cannot send the bearer token, so the file is fetched and
 * played from a blob URL instead.
 *
 * Unlike the image version this does NOT wait for the element to scroll into
 * view. It is used where someone has deliberately opened a preview, and a
 * video that only starts loading once observed looks broken.
 */
export function AuthorizedVideo({
  url,
  token,
  controls = true,
  style,
}: {
  url: string;
  token: string | null;
  controls?: boolean;
  style?: CSSProperties;
}) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const [state, setState] = useState<State>({ kind: "waiting" });

  useEffect(() => {
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
  }, [url, token]);

  const box: CSSProperties = {
    width: "100%",
    height: "100%",
    display: "grid",
    placeItems: "center",
    color: "var(--ink-3)",
    fontSize: 11,
    ...style,
  };

  if (state.kind === "loaded") {
    return (
      <video
        src={state.src}
        controls={controls}
        playsInline
        // Muted so a tile that autoplays nothing still shows its first frame
        // without the browser refusing; the user unmutes via the controls.
        muted={!controls}
        preload="metadata"
        style={{ width: "100%", height: "100%", objectFit: "contain", display: "block", background: "#000", ...style }}
      />
    );
  }

  return (
    <div style={box} aria-busy={state.kind === "waiting"}>
      {state.kind === "waiting" ? (
        <div
          aria-label={tx("Loading video", "جارٍ تحميل الفيديو")}
          style={{ width: "100%", height: "100%", background: "var(--bg-3)", animation: "pulse 1.4s ease-in-out infinite" }}
        />
      ) : (
        <div style={{ display: "grid", justifyItems: "center", gap: 6, textAlign: "center", padding: 8 }}>
          <IconAlert w={16} />
          <span>{state.missing ? tx("File missing", "الملف غير موجود") : tx("Couldn't load", "تعذّر التحميل")}</span>
        </div>
      )}
    </div>
  );
}
