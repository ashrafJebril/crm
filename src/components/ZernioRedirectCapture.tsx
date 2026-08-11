import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { makeTx } from "@/lib/tx";
import { useTweaks } from "@/tweaks/context";
import { useToast } from "./Toast";

interface SyncResult {
  connected: Array<{ platform: string; accountId: string; name: string | null }>;
}

/** Zernio's platform slugs → the names customers actually recognise. */
const PLATFORM_LABELS: Record<string, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  tiktok: "TikTok",
  whatsapp: "WhatsApp",
  snapchat: "Snapchat",
};

const labelFor = (platform: string) =>
  PLATFORM_LABELS[platform.toLowerCase()] ?? platform;

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
  const { t } = useTweaks();
  const qc = useQueryClient();
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

    const tx = makeTx(t.lang);
    const platform = (params.get("platform") ?? "").toLowerCase();

    api
      .post<SyncResult>("/integrations/zernio/sync")
      .then((res) => {
        // Integration status queries carry a 30s staleTime, and the Dashboard
        // pre-warms them — so by now the cache may already hold a pre-connect
        // "not connected" answer that React Query won't refetch on its own.
        // Dropping those entries is what makes the Settings cards flip to Live
        // on their own, instead of only after a manual page reload.
        void qc.invalidateQueries({
          predicate: (q) =>
            typeof q.queryKey[0] === "string" &&
            (q.queryKey[0] as string).startsWith("/integrations"),
        });

        // Zernio redirects back with `zernio=connected` even when the customer
        // abandoned the flow part-way (Instagram's professional-account wall is
        // the common one), so believe the reconciled list, not the redirect.
        const accounts = res?.connected ?? [];
        const hit = platform
          ? accounts.find((a) => a.platform?.toLowerCase() === platform)
          : accounts[0];

        if (!hit) {
          const name = platform ? labelFor(platform) : tx("The account", "الحساب");
          toast(
            tx(
              `${name} wasn't connected — the authorisation didn't finish.`,
              `لم يتم ربط ${name} — لم تكتمل عملية التفويض.`,
            ),
            "error",
          );
          return;
        }

        const name = labelFor(hit.platform);
        const suffix = hit.name ? ` · ${hit.name}` : "";
        toast(
          tx(`${name} connected${suffix} ✓`, `تم ربط ${name}${suffix} ✓`),
          "success",
        );
      })
      .catch((e) =>
        toast(
          e instanceof Error
            ? e.message
            : tx(
                "Couldn't record the Zernio connection",
                "تعذّر تسجيل الاتصال عبر Zernio",
              ),
          "error",
        ),
      )
      .finally(() => {
        // Drop the query from the hash so a refresh doesn't re-fire.
        const cleanHash = qIndex >= 0 ? hash.slice(0, qIndex) : hash;
        window.history.replaceState(null, "", window.location.pathname + (cleanHash || ""));
      });
  }, [toast, qc, t.lang]);

  return null;
}
