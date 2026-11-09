import { useFetch } from "@/api/useFetch";
import { usePermissions } from "@/auth/usePermissions";
import type { Tx } from "@/lib/tx";
import type { SendersResponse } from "@/lib/types";
import { channelsLinkText, whatsAppGateText } from "./whatsAppGateCopy";

/**
 * Whether the workspace can send WhatsApp marketing (GET /campaigns/senders,
 * campaigns.view). `connected` is null while loading or when the role can't
 * read it: nothing is disabled up front then, and the action's own 409
 * (`isWhatsAppNotConnected`) shows the same copy.
 */
export function useWhatsAppConnection(enabled = true): {
  connected: boolean | null;
  senders: SendersResponse | null;
  refetch: () => Promise<void>;
} {
  const { can } = usePermissions();
  const q = useFetch<SendersResponse>(enabled && can("campaigns.view") ? "/campaigns/senders" : null);
  return { connected: q.data ? q.data.connected : null, senders: q.data, refetch: q.refetch };
}

/** The one bilingual "WhatsApp isn't connected" banner (Campaigns and Templates). */
export function WhatsAppGate({ connected, tx }: { connected: boolean | null; tx: Tx }) {
  const { can } = usePermissions();
  if (connected !== false) return null;
  return (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
        padding: "10px 14px",
        borderRadius: 10,
        fontSize: 13,
        lineHeight: 1.5,
        background: "color-mix(in oklch, var(--warn) 10%, var(--bg-1))",
        border: "1px solid color-mix(in oklch, var(--warn) 45%, transparent)",
        color: "var(--ink)",
      }}
    >
      <span style={{ flex: 1, minWidth: 220 }}>{whatsAppGateText(tx)}</span>
      {can("channels.view") && (
        <a href="#/channels" className="btn sm" style={{ textDecoration: "none" }}>
          {channelsLinkText(tx)}
        </a>
      )}
    </div>
  );
}
