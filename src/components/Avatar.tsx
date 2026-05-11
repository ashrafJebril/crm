import { memo } from "react";
import type { Agent } from "@/lib/types";

interface AvatarProps {
  name?: string;
  agent?: Agent;
  size?: "" | "sm" | "lg" | "xl";
  color?: string;
  ai?: boolean;
}

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i);
  return h;
}

function AvatarImpl({ name = "?", agent, size = "", color, ai = false }: AvatarProps) {
  if (ai && agent) {
    const next = (parseInt(agent.color, 10) + 80) % 360;
    return (
      <span
        className={`avatar ai ${size}`.trim()}
        style={{
          background: `linear-gradient(135deg, oklch(0.78 0.18 ${agent.color}), oklch(0.62 0.18 ${next}))`,
        }}
      >
        {agent.emoji}
      </span>
    );
  }

  const initials = name
    .split(" ")
    .map((s) => s[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const hue = color ?? agent?.color ?? String(Math.abs(hash(name)) % 360);

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
