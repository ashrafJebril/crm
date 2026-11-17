import { useState } from "react";
import { usePermissions } from "@/auth/usePermissions";
import type { Tx } from "@/lib/tx";
import { MESSAGE_MAX } from "./copilotConstants";
import { openCopilot, useCopilotAvailable } from "./copilotApi";

/**
 * SP-18 (ruling 11) "Ask about these numbers" on the insights tabs: shown
 * with reports.view when the copilot is available. The question opens a new
 * chat in the drawer; the page sends only its ids and range, and the server
 * recomputes the numbers as the member (summarize_insights).
 */
export function InsightsAskBox({ tx }: { tx: Tx }) {
  const { can } = usePermissions();
  const available = useCopilotAvailable();
  const [q, setQ] = useState("");
  if (!available || !can("reports.view")) return null;
  const ask = () => {
    const text = q.trim();
    if (!text) return;
    openCopilot({ prompt: text });
    setQ("");
  };
  return (
    <form
      className="copilot-askbox"
      onSubmit={(e) => {
        e.preventDefault();
        ask();
      }}
    >
      <input
        dir="auto"
        value={q}
        maxLength={MESSAGE_MAX}
        placeholder={tx("Ask about these numbers…", "اسأل عن هذه الأرقام…")}
        aria-label={tx("Ask about these numbers", "اسأل عن هذه الأرقام")}
        onChange={(e) => setQ(e.target.value)}
      />
      <button type="submit" className="btn sm" disabled={!q.trim()}>
        {tx("Ask Kewy", "اسأل كيوي")}
      </button>
    </form>
  );
}
