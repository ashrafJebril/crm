import { memo, useState } from "react";

interface AvatarProps {
  name?: string;
  size?: "" | "sm" | "lg" | "xl";
  color?: string;
  /** Picture URL from the platform. Initials are kept underneath and show
   *  again if it fails: these are third-party CDN links that expire, and a
   *  blank circle is worse than the letters we had. */
  src?: string | null;
}

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i);
  return h;
}

function AvatarImpl({ name = "?", size = "", color, src }: AvatarProps) {
  const [broken, setBroken] = useState(false);
  const initials = name
    .split(" ")
    .map((s) => s[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const hue = color ?? String(Math.abs(hash(name)) % 360);

  return (
    <span
      className={`avatar ${size}`.trim()}
      style={{
        background: `oklch(0.32 0.06 ${hue})`,
        color: `oklch(0.92 0.06 ${hue})`,
        position: "relative",
        overflow: "hidden",
      }}
    >
      {initials}
      {src && !broken && (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          // Meta's CDN refuses some requests that carry a referrer.
          referrerPolicy="no-referrer"
          onError={() => setBroken(true)}
          style={{
            position: "absolute", inset: 0, width: "100%", height: "100%",
            objectFit: "cover", display: "block",
          }}
        />
      )}
    </span>
  );
}

export const Avatar = memo(AvatarImpl);
