import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useConnectFlow } from "@/embed/useConnectFlow";
import { invalidateIntegrations } from "@/embed/connected";
import type { Tx } from "@/lib/tx";
import { channelErrorText } from "@/screens/channels/channelErrors";

/**
 * Zernio's hosted connect, slimmed to its connect and sync logic (SP-19 T5).
 * The per-platform cards moved to the channels hub (`#/channels`), which uses
 * this hook from its Add channel dialog and its Reconnect action.
 *
 * Connect: GET /integrations/zernio/connect/:platform returns Zernio's auth
 * URL, opened by `useConnectFlow` (redirect, or a popup when embedded). The
 * redirect back (`#/channels?zernio=connected&platform=…`) is reconciled by
 * ZernioRedirectCapture. A WhatsApp link at the plan limit answers 409
 * `channels.limit_reached {limit, plan}`, shown as localized text (m3).
 */

export interface ZernioPlatform {
  key: string;
  label: string;
  color: string;
}

export const ZERNIO_PLATFORMS: ZernioPlatform[] = [
  { key: "whatsapp", label: "WhatsApp", color: "#25D366" },
  { key: "facebook", label: "Facebook", color: "#1877F2" },
  { key: "instagram", label: "Instagram", color: "#E1306C" },
  { key: "tiktok", label: "TikTok", color: "#000000" },
];

export function useZernioConnect(tx: Tx) {
  const connect = useConnectFlow();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(
    async (platform: string) => {
      setError(null);
      setBusy(platform);
      try {
        await connect(async () => {
          const { authUrl } = await api.get<{ authUrl: string }>(
            `/integrations/zernio/connect/${encodeURIComponent(platform)}`,
          );
          return authUrl;
        });
      } catch (e) {
        setError(channelErrorText(e, tx));
      } finally {
        setBusy(null);
      }
    },
    [connect, tx],
  );

  /** Re-read Zernio's accounts and mirror them into channels (POST /channels/sync). */
  const sync = useCallback(async () => {
    setError(null);
    setBusy("sync");
    try {
      await api.post("/channels/sync");
      invalidateIntegrations(qc);
      return true;
    } catch (e) {
      setError(channelErrorText(e, tx));
      return false;
    } finally {
      setBusy(null);
    }
  }, [qc, tx]);

  return { start, sync, busy, error, clearError: () => setError(null) };
}
