import type { ComponentType } from "react";
import type { TriggerKind } from "@/lib/automations";
import { IconCal, IconClock, IconInbox, IconLayers, IconSend, IconTag, IconUsers } from "@/icons";

type Icon = ComponentType<{ w?: number }>;

export interface Tint {
  fg: string;
  bg: string;
}

export const TRIGGER_ICON: Record<TriggerKind, Icon> = {
  "contact.created": IconUsers,
  "deal.stage_changed": IconLayers,
  "conversation.started": IconInbox,
  "appointment.booked": IconCal,
  "appointment.upcoming": IconClock,
  "contact.tagged": IconTag,
};

// One hue per trigger so the list, tiles, and review read at a glance.
export const TRIGGER_TINT: Record<TriggerKind, Tint> = {
  "contact.created": { fg: "oklch(0.58 0.15 150)", bg: "oklch(0.78 0.16 150 / 0.16)" },
  "deal.stage_changed": { fg: "var(--accent)", bg: "var(--accent-soft)" },
  "conversation.started": { fg: "oklch(0.58 0.13 240)", bg: "oklch(0.74 0.13 240 / 0.16)" },
  "appointment.booked": { fg: "oklch(0.58 0.13 300)", bg: "oklch(0.74 0.13 300 / 0.16)" },
  "appointment.upcoming": { fg: "oklch(0.62 0.15 65)", bg: "oklch(0.82 0.17 78 / 0.2)" },
  "contact.tagged": { fg: "oklch(0.6 0.16 20)", bg: "oklch(0.7 0.2 24 / 0.14)" },
};

export type Channel = "whatsapp" | "email";

export const CHANNEL_META: Record<Channel, Tint & { Icon: Icon; en: string; ar: string }> = {
  whatsapp: { fg: "oklch(0.58 0.15 150)", bg: "oklch(0.78 0.16 150 / 0.16)", Icon: IconSend, en: "WhatsApp", ar: "واتساب" },
  email: { fg: "oklch(0.58 0.13 240)", bg: "oklch(0.74 0.13 240 / 0.16)", Icon: IconInbox, en: "Email", ar: "بريد إلكتروني" },
};

/** Icon inside a soft colored circle. */
export function TintIcon({ Icon, tint, size = 36 }: { Icon: Icon; tint: Tint; size?: number }) {
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: tint.bg,
        color: tint.fg,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <Icon w={Math.round(size * 0.47)} />
    </span>
  );
}
