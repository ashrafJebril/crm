import { useEffect, useRef } from "react";
import { api } from "@/api/client";
import { useToast } from "./Toast";

/**
 * Captures Zernio's hosted-connect success redirect.
 *
 * After a customer authenticates a platform through Zernio, the browser returns
 * to our app at `…/#/settings?zernio=connected&platform=<p>`. Zernio knows about
 * the connection but our backend doesn't until we reconcile — so on load we
 * detect those params, POST /integrations/zernio/sync (upserts the connected
 * accounts against the current workspace), toast, then strip the params.
 *
 * Mounted once inside the authenticated tree so it runs wherever the redirect
 * lands. The `account.connected` webhook also triggers a sync server-side, so
 * this is a fast-path, not the only path — and it's idempotent either way.
 */
export function ZernioRedirectCapture() {
  const { toast } = useToast();
  const done = useRef(false);

  useEffect(() => {
    if (done.current) return;
    // Params live in the hash (…/#/settings?zernio=…) since the app is hash-routed.
    const hash = window.location.hash;
    const qIndex = hash.indexOf("?");
    const params = new URLSearchParams(
      qIndex >= 0 ? hash.slice(qIndex + 1) : window.location.search,
    );
    if (params.get("zernio") !== "connected") return;
    done.current = true;

    const platform = params.get("platform") ?? "account";

    api
      .post("/integrations/zernio/sync")
      .then(() => toast(`${platform} connected via Zernio ✓`, "success"))
      .catch((e) =>
        toast(
          e instanceof Error ? e.message : "Couldn't record the Zernio connection",
          "error",
        ),
      )
      .finally(() => {
        // Drop the query from the hash so a refresh doesn't re-fire.
        const cleanHash = qIndex >= 0 ? hash.slice(0, qIndex) : hash;
        window.history.replaceState(null, "", window.location.pathname + (cleanHash || ""));
      });
  }, [toast]);

  return null;
}
