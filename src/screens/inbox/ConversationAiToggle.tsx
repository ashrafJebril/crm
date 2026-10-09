import { useState } from "react";
import { api } from "@/api/client";
import { makeTx } from "@/lib/tx";
import type { Lang } from "@/lib/types";

/**
 * Per-conversation AI switch.
 *
 * Deliberately scoped to ONE thread rather than the whole workspace: turning
 * the agent on for a tenant must never retroactively start answering
 * conversations that a human is already handling. `aiEnabled` defaults to false
 * on the server for the same reason.
 *
 * `aiPausedAt` is set by the backend whenever a human sends into an AI thread,
 * so the agent backs off. Toggling here clears it — the operator flipping the
 * switch IS the decision to let it speak again.
 */
export function ConversationAiToggle({
  conversationId,
  enabled,
  pausedAt,
  lang,
  onChanged,
}: {
  conversationId: string;
  enabled: boolean;
  pausedAt?: string | null;
  lang: Lang;
  onChanged?: (next: { aiEnabled: boolean; aiPausedAt: string | null }) => void;
}) {
  const tx = makeTx(lang);
  const [busy, setBusy] = useState(false);
  const [on, setOn] = useState(enabled);
  const [paused, setPaused] = useState<string | null>(pausedAt ?? null);

  async function toggle() {
    if (busy) return;
    setBusy(true);
    const next = !on;
    // Optimistic: the switch should feel instant. Rolled back on failure so the
    // UI never claims the AI is live when the server disagreed.
    setOn(next);
    try {
      const res = await api.post<{ aiEnabled: boolean; aiPausedAt: string | null }>(
        `/conversations/${conversationId}/ai`,
        { enabled: next },
      );
      setOn(res.aiEnabled);
      setPaused(res.aiPausedAt);
      onChanged?.(res);
    } catch {
      setOn(!next);
    } finally {
      setBusy(false);
    }
  }

  const isPaused = on && !!paused;
  const label = !on
    ? tx("AI off", "الذكاء الاصطناعي مغلق")
    : isPaused
      ? tx("AI paused", "الذكاء الاصطناعي متوقف")
      : tx("AI on", "الذكاء الاصطناعي مفعّل");

  return (
    <button
      className="btn"
      onClick={toggle}
      disabled={busy}
      title={
        isPaused
          ? tx(
              "A human replied, so the AI stepped back. Click to hand the thread back to it.",
              "ردّ موظف، فتوقّف الذكاء الاصطناعي. اضغط لإعادة المحادثة له.",
            )
          : on
            ? tx("The AI is answering this conversation", "الذكاء الاصطناعي يردّ على هذه المحادثة")
            : tx("Let the AI answer this conversation", "دع الذكاء الاصطناعي يردّ على هذه المحادثة")
      }
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        // Paused is amber, not green: "on but silent" is a genuinely different
        // state and staff need to see it without hovering.
        borderColor: isPaused ? "var(--warn)" : on ? "var(--ok, var(--accent))" : undefined,
        color: isPaused ? "var(--warn)" : undefined,
        opacity: busy ? 0.6 : 1,
      }}
    >
      <span aria-hidden>{on ? (isPaused ? "⏸" : "🤖") : "🤖"}</span>
      {label}
    </button>
  );
}
