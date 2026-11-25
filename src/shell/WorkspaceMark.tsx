import { useState } from "react";
import { API_BASE } from "@/api/client";
import { brandInk, safeBrandColor, workspaceInitials } from "@/lib/brandColor";

/**
 * SP-29 workspace mark (R3/R4): the workspace logo in a fixed box
 * (`object-fit: contain`), or its initials on the brand colour with the
 * higher-contrast ink. The colour is re-validated here (only `#rrggbb` ever
 * reaches a style); with no colour the mark keeps the app's default gradient.
 * The app accent is never changed.
 */
export function WorkspaceMark({
  name,
  logoUrl,
  brandColor,
  size = 28,
}: {
  name: string;
  logoUrl?: string | null;
  brandColor?: string | null;
  size?: number;
}) {
  const [broken, setBroken] = useState<string | null>(null);
  const color = safeBrandColor(brandColor);
  // Only the same-origin public logo route (what the API returns).
  const logo = typeof logoUrl === "string" && /^\/api\/branding\/[^/?#\s]+\/logo\/[^/?#\s]+$/.test(logoUrl) && broken !== logoUrl ? logoUrl : null;
  const base = { width: size, height: size, borderRadius: Math.round(size / 4), flex: "0 0 auto" } as const;
  if (logo) {
    return (
      <span className="ws-mark-logo" style={{ ...base, display: "inline-flex", alignItems: "center", justifyContent: "center", background: "#ffffff", overflow: "hidden" }}>
        <img src={apiAbsolute(logo)} alt="" width={size} height={size} style={{ width: "100%", height: "100%", objectFit: "contain" }} onError={() => setBroken(logo)} />
      </span>
    );
  }
  if (!color) return <div className="ws-mark" style={base} aria-hidden="true" />;
  return (
    <span
      aria-hidden="true"
      style={{
        ...base,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        background: color,
        color: brandInk(color),
        fontSize: Math.max(9, Math.round(size * 0.38)),
        fontWeight: 600,
        lineHeight: 1,
      }}
    >
      <bdi>{workspaceInitials(name)}</bdi>
    </span>
  );
}

/** `/api/branding/…` on the API's origin (the app may be served from another origin in dev). */
function apiAbsolute(path: string): string {
  const origin = API_BASE.replace(/\/api\/?$/, "");
  return `${origin}${path}`;
}
