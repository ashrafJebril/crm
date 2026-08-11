import { memo } from "react";

interface AvatarProps {
  name?: string;
  size?: "" | "sm" | "lg" | "xl";
  color?: string;
}

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i);
  return h;
}

function AvatarImpl({ name = "?", size = "", color }: AvatarProps) {
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
      }}
    >
      {initials}
    </span>
  );
}

export const Avatar = memo(AvatarImpl);
