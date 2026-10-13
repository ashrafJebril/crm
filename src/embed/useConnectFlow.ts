import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/components/Toast";
import {
  abortConnectWindow,
  beginConnectWindow,
  isEmbedded,
  navigateConnectWindow,
  watchConnectWindow,
} from "./embed";

import { invalidateIntegrations } from "./connected";

export { invalidateIntegrations };

/**
 * Runs a connect flow. `getUrl` performs the API call. Embedded: popup is opened
 * synchronously first. Standalone: plain redirect. Errors from getUrl propagate
 * (after closing the popup) so callers keep their own error UI.
 */
export function useConnectFlow() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useCallback(
    async (getUrl: () => Promise<string>): Promise<void> => {
      if (!isEmbedded()) {
        window.location.href = await getUrl();
        return;
      }
      const handle = beginConnectWindow();
      if (!handle) throw new Error("Allow pop-ups to connect accounts");
      let url: string;
      try {
        url = await getUrl();
      } catch (e) {
        abortConnectWindow(handle);
        throw e;
      }
      navigateConnectWindow(handle, url);
      watchConnectWindow(handle, () => {
        invalidateIntegrations(qc);
        toast("Checking connection…");
      });
    },
    [qc, toast],
  );
}
