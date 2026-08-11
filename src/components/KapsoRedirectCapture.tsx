import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useToast } from "./Toast";

/**
 * Captures the Kapso embedded-signup success redirect.
 *
 * After a customer connects their WABA, Kapso sends the browser back to our
 * app root with query params, e.g.
 *   https://aramhub.net/?phone_number_id=…&business_account_id=…&status=completed
 * Kapso knows about the connection, but our backend doesn't until we tell it —
 * so on load we read those params, POST them to /integrations/kapso/connected
 * (records against the current workspace), then strip them from the URL.
 *
 * Mounted once inside the authenticated tree so it runs whenever the redirect
 * lands (the app boots at the root route, not necessarily Settings).
 */
export function KapsoRedirectCapture() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const done = useRef(false);

  useEffect(() => {
    if (done.current) return;
    const params = new URLSearchParams(window.location.search);
    const phoneNumberId = params.get("phone_number_id");
    if (params.get("status") !== "completed" || !phoneNumberId) return;
    done.current = true;

    const wabaId = params.get("business_account_id") ?? undefined;
    const displayPhoneNumber = params.get("display_phone_number") ?? undefined;

    api
      .post("/integrations/kapso/connected", { phoneNumberId, wabaId, displayPhoneNumber })
      .then(() => {
        // Integration statuses are cached with a 30s staleTime, so without this
        // the Settings card keeps showing "Not connected" until a manual reload.
        void qc.invalidateQueries({
          predicate: (q) =>
            typeof q.queryKey[0] === "string" &&
            (q.queryKey[0] as string).startsWith("/integrations"),
        });
        toast("WhatsApp connected via Kapso ✓", "success");
      })
      .catch((e) =>
        toast(
          e instanceof Error ? e.message : "Couldn't record the WhatsApp connection",
          "error",
        ),
      )
      .finally(() => {
        // Drop the query params so a refresh doesn't re-fire; keep any hash route.
        const clean = window.location.pathname + (window.location.hash || "");
        window.history.replaceState(null, "", clean || "/");
      });
  }, [toast, qc]);

  return null;
}
