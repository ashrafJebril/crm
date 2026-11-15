import type { CSSProperties } from "react";
import type { Tx } from "@/lib/tx";
import type { Ticket } from "@/lib/types";
import { TONE_COLOR, channelLabel, priorityChipShown, priorityLabel, priorityTone, type Tone } from "./ticketFields";
import { slaBadge, ticketSlaState } from "./ticketSla";

/** SP-09 chips shared by the card, the table and the ticket sheet. */

const chip = (tone: Tone, strong = false): CSSProperties => {
  const c = TONE_COLOR[tone];
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    paddingInline: 6,
    paddingBlock: 1,
    borderRadius: 999,
    fontSize: 10.5,
    fontWeight: 600,
    lineHeight: 1.5,
    whiteSpace: "nowrap",
    color: tone === "muted" ? "var(--ink-2)" : c,
    background: `color-mix(in srgb, ${c} ${strong ? 16 : 10}%, transparent)`,
    border: `1px solid color-mix(in srgb, ${c} ${strong ? 45 : 28}%, transparent)`,
  };
};

/** Priority chip; `always` shows normal/low too (table, sheet), else only high/urgent (card). */
export function PriorityChip({ tx, priority, always = false }: { tx: Tx; priority: unknown; always?: boolean }) {
  if (!always && !priorityChipShown(priority)) return null;
  const tone = priorityTone(priority);
  return (
    <span style={chip(tone, tone === "bad")} data-priority={String(priority ?? "normal")}>
      {priorityLabel(tx, priority)}
    </span>
  );
}

/**
 * SLA badge from the ticket's due date and its stage's terminal flag.
 * `showNone` renders "No SLA" (table, sheet); `showOnTrack` the calm "Due …" badge.
 */
export function SlaBadgeChip({
  tx,
  tz,
  ticket,
  stageIsTerminal,
  showNone = false,
  showOnTrack = true,
  now,
}: {
  tx: Tx;
  tz: string;
  ticket: Pick<Ticket, "slaDueAt" | "closedAt" | "stage">;
  stageIsTerminal?: boolean;
  showNone?: boolean;
  showOnTrack?: boolean;
  now?: Date;
}) {
  const state = ticketSlaState(ticket, stageIsTerminal, now);
  const b = slaBadge(state, ticket.slaDueAt, tz, tx);
  if (!b) return null;
  if (b.state === "none" && !showNone) return null;
  if (b.state === "on_track" && !showOnTrack) return null;
  return (
    <span style={chip(b.tone, b.state === "breached")} title={b.title} data-sla={b.state}>
      {b.state === "on_track" && b.due ? (
        <>
          {tx("Due", "تستحق")} <bdi>{b.due}</bdi>
        </>
      ) : (
        b.label
      )}
    </span>
  );
}

/** Channel chip; renders nothing when the ticket has no (visible) conversation. */
export function ChannelChip({ tx, channel }: { tx: Tx; channel: Ticket["channel"] }) {
  const label = channelLabel(tx, channel);
  if (!label) return null;
  return (
    <span style={chip("muted")} dir="auto" data-channel={channel?.kind}>
      {label}
    </span>
  );
}

/** Paperclip and count; nothing for zero or an unknown count. */
export function AttachmentCount({ tx, count }: { tx: Tx; count: number | undefined }) {
  if (!count) return null;
  return (
    <span
      title={tx(`Files: ${count}`, `عدد الملفات: ${count}`)}
      aria-label={tx(`Files: ${count}`, `عدد الملفات: ${count}`)}
      style={{ display: "inline-flex", alignItems: "center", gap: 2, fontSize: 10.5, color: "var(--ink-3)" }}
    >
      <span aria-hidden="true">📎</span>
      <bdi>{count}</bdi>
    </span>
  );
}
