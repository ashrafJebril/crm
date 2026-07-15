import { useCallback, useEffect, useRef, useState } from "react";
import { useFetch, useMutation } from "@/api/useFetch";
import { api } from "@/api/client";
import { Badge } from "@/components/Badge";
import { SettingsCard, StatusToast, ErrorRow } from "./form";

interface KapsoStatus {
  connected: boolean;
  provider: "kapso";
  phoneNumberId?: string;
  displayPhoneNumber?: string | null;
  wabaId?: string;
  lastFetchedAt?: string | null;
}

interface KapsoCardProps {
  tx: (en: string, ar: string) => string;
  canEdit: boolean;
}

/**
 * WhatsApp via Kapso (BSP embedded signup). The customer connects their own
 * WABA through a Kapso-hosted setup link — no Meta App Review, no token paste.
 * We open the link, then poll status until the `whatsapp.phone_number.created`
 * webhook records the connection on the backend.
 */
export function KapsoCard({ tx, canEdit }: KapsoCardProps) {
  const statusQ = useFetch<KapsoStatus>("/integrations/kapso/status");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const pollRef = useRef<number | null>(null);

  const setupMut = useMutation<void, { url: string }>(() =>
    api.post("/integrations/kapso/setup-link"),
  );
  const disconnectMut = useMutation<void, { ok: boolean }>(() =>
    api.delete("/integrations/kapso/disconnect"),
  );

  const flash = (msg: string) => {
    setStatus(msg);
    window.setTimeout(() => setStatus(null), 2600);
  };

  // Poll status while we're waiting for the customer to finish embedded signup.
  const startPolling = useCallback(() => {
    setWaiting(true);
    if (pollRef.current) window.clearInterval(pollRef.current);
    pollRef.current = window.setInterval(() => {
      void statusQ.refetch();
    }, 4000);
  }, [statusQ]);

  useEffect(() => {
    if (statusQ.data?.connected && pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
      setWaiting(false);
      flash(tx("WhatsApp connected via Kapso.", "تم ربط واتساب عبر Kapso."));
    }
  }, [statusQ.data?.connected, tx]);

  // If we returned from the Kapso success redirect, refetch immediately.
  useEffect(() => {
    if (window.location.hash.includes("kapso=connected")) {
      void statusQ.refetch();
    }
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onConnect = async () => {
    setError(null);
    try {
      const { url } = await setupMut.mutate();
      window.open(url, "_blank", "noopener");
      startPolling();
      flash(tx("Opened Kapso signup — finish it in the new tab.", "افتح تسجيل Kapso في التبويب الجديد."));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create setup link");
    }
  };

  const onDisconnect = async () => {
    setError(null);
    try {
      await disconnectMut.mutate();
      void statusQ.refetch();
      flash(tx("Disconnected.", "تم قطع الاتصال."));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to disconnect");
    }
  };

  const connected = statusQ.data?.connected;

  return (
    <SettingsCard
      title={tx("WhatsApp via Kapso", "واتساب عبر Kapso")}
      description={tx(
        "Connect a customer's WhatsApp Business number through Kapso's hosted signup — no Meta App Review or token needed.",
        "اربط رقم واتساب للأعمال عبر تسجيل Kapso — بدون مراجعة تطبيق Meta أو رمز.",
      )}
      footer={
        canEdit ? (
          connected ? (
            <button className="btn ghost" onClick={onDisconnect} disabled={disconnectMut.loading}>
              {disconnectMut.loading ? tx("Disconnecting…", "جارٍ القطع…") : tx("Disconnect", "قطع الاتصال")}
            </button>
          ) : (
            <button className="btn primary" onClick={onConnect} disabled={setupMut.loading}>
              {setupMut.loading
                ? tx("Preparing…", "جارٍ التحضير…")
                : tx("Connect via Kapso", "اربط عبر Kapso")}
            </button>
          )
        ) : null
      }
    >
      <ErrorRow message={error} />
      {connected ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Badge kind="ok" dot>
            {tx("Connected", "متصل")}
          </Badge>
          <span className="mono" style={{ fontSize: 13 }}>
            {statusQ.data?.displayPhoneNumber ?? statusQ.data?.phoneNumberId}
          </span>
        </div>
      ) : (
        <div className="muted" style={{ fontSize: 12 }}>
          {waiting
            ? tx(
                "Waiting for the customer to finish connecting…",
                "بانتظار إكمال العميل عملية الربط…",
              )
            : tx("Not connected.", "غير متصل.")}
        </div>
      )}
      <StatusToast message={status} />
    </SettingsCard>
  );
}
