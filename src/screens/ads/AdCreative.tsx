import { useEffect, useState, type CSSProperties } from "react";
import { API_BASE, tokenStore } from "@/api/client";
import { IconCampaign, IconPlay } from "@/icons";
import { loadMedia } from "@/lib/mediaFetch";

/** `/api/media/<id>/file` (our re-hosted copy) resolves against the API origin and needs the bearer token. */
function resolve(imageUrl: string): { url: string; authed: boolean } | null {
  if (imageUrl.startsWith("/api/")) return { url: API_BASE.replace(/\/api\/?$/, "") + imageUrl, authed: true };
  if (/^https:\/\//i.test(imageUrl)) return { url: imageUrl, authed: false };
  return null;
}

/**
 * An ad's creative thumbnail. A re-hosted image is fetched with the token
 * (`<img>` can't send it); Meta's own link may have expired. Any failure, or
 * no image at all, shows a neutral placeholder.
 */
export function AdCreative({
  imageUrl,
  mediaType,
  size = 56,
  radius = 8,
  alt = "",
}: {
  imageUrl: string | null | undefined;
  mediaType?: string | null;
  size?: number | "fill";
  radius?: number;
  alt?: string;
}) {
  const target = imageUrl ? resolve(imageUrl) : null;
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    setSrc(null);
    if (!target) return;
    if (!target.authed) {
      setSrc(target.url);
      return;
    }
    const ctrl = new AbortController();
    let objectUrl: string | null = null;
    loadMedia(target.url, tokenStore.get(), ctrl.signal)
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setFailed(true);
      });
    return () => {
      ctrl.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [target?.url]);

  const box: CSSProperties = {
    width: size === "fill" ? "100%" : size,
    height: size === "fill" ? "100%" : size,
    borderRadius: radius,
    overflow: "hidden",
    flexShrink: 0,
    background: "var(--bg-3)",
    display: "grid",
    placeItems: "center",
    color: "var(--ink-4)",
    position: "relative",
  };
  const iconW = size === "fill" ? 22 : Math.max(10, Math.round(size / 2.6));

  return (
    <span style={box}>
      {src && !failed ? (
        <img
          src={src}
          alt={alt}
          referrerPolicy="no-referrer"
          loading="lazy"
          onError={() => setFailed(true)}
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
      ) : (
        <span aria-hidden>
          <IconCampaign w={iconW} />
        </span>
      )}
      {mediaType === "video" && src && !failed && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            insetInlineEnd: 3,
            bottom: 3,
            background: "rgba(0,0,0,.55)",
            color: "#fff",
            borderRadius: 99,
            display: "grid",
            placeItems: "center",
            padding: 2,
          }}
        >
          <IconPlay w={8} />
        </span>
      )}
    </span>
  );
}
