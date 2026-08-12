import { useState } from "react";
import { useFetch } from "@/api/useFetch";
import { api } from "@/api/client";
import { Badge } from "@/components/Badge";
import { IconGlobe, IconX } from "@/icons";
import { SettingsCard, StatusToast, ErrorRow } from "./form";

interface ZernioAccount {
  platform: string;
  accountId: string | null;
  name: string | null;
  connectedAt?: string;
}
interface ZernioStatus {
  configured: boolean;
  profileConnected: boolean;
  accounts: ZernioAccount[];
}

interface PlatformDef {
  key: string;
  label: string;
  color: string;
  /** Zernio has this platform in beta; connect is blocked server-side. */
  beta?: boolean;
  note?: (tx: Tx) => string;
}

type Tx = (en: string, ar: string) => string;

const PLATFORMS: PlatformDef[] = [
  { key: "facebook", label: "Facebook", color: "#1877F2" },
  {
    key: "instagram",
    label: "Instagram",
    color: "#E1306C",
  },
  {
    key: "tiktok",
    label: "TikTok",
    color: "#010101",
    note: (tx) => tx("Publishing only (no DMs/comments via Zernio).", "النشر فقط (بدون رسائل/تعليقات عبر Zernio)."),
  },
  {
    key: "whatsapp",
    label: "WhatsApp",
    color: "#25D366",
  },
  {
    key: "snapchat",
    label: "Snapchat",
    color: "#FFFC00",
    beta: true,
    note: (tx) => tx("In beta at Zernio — not yet available.", "قيد التجربة في Zernio — غير متاح بعد."),
  },
];

interface ZernioCardProps {
  tx: Tx;
  canEdit: boolean;
}

/**
 * Connect Facebook, Instagram, TikTok, WhatsApp and (when Zernio ships it)
 * Snapchat through Zernio's hosted OAuth — the customer just authenticates, no
 * Meta App Review or Tester enrollment. Each platform maps to a provider="zernio"
 * Integration row on the backend; the redirect back is reconciled by
 * ZernioRedirectCapture (POST /integrations/zernio/sync).
 */
export function ZernioCard({ tx, canEdit }: ZernioCardProps) {
  const statusQ = useFetch<ZernioStatus>("/integrations/zernio/status");
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const flash = (msg: string) => {
    setStatus(msg);
    window.setTimeout(() => setStatus(null), 2600);
  };

  // Returning from the hosted connect flow needs no special handling here:
  // ZernioRedirectCapture invalidates every /integrations query once the sync
  // has actually reconciled, which repaints this card on its own. (It used to
  // guess with a refetch + a 1.5s timer, which raced the sync and lost.)

  const accountFor = (platform: string) =>
    statusQ.data?.accounts?.find((a) => a.platform === platform);

  const onConnect = async (platform: string) => {
    setError(null);
    setBusy(platform);
    try {
      const { authUrl } = await api.get<{ authUrl: string }>(
        `/integrations/zernio/connect/${platform}`,
      );
      window.location.href = authUrl;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start the connect flow");
      setBusy(null);
    }
  };

  const onDisconnect = async (platform: string) => {
    setError(null);
    setBusy(platform);
    try {
      await api.delete(`/integrations/zernio/${platform}`);
      await statusQ.refetch();
      flash(tx("Disconnected.", "تم قطع الاتصال."));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to disconnect");
    } finally {
      setBusy(null);
    }
  };

  const notConfigured = statusQ.data && !statusQ.data.configured;

  return (
    <SettingsCard
      title={tx("Social accounts via Zernio", "حسابات التواصل عبر Zernio")}
      description={tx(
        "Connect Facebook, Instagram, TikTok and WhatsApp with one click — the customer just authenticates, no Meta App Review or token needed.",
        "اربط فيسبوك وإنستغرام وتيك توك وواتساب بنقرة واحدة — يوثّق العميل فقط، بدون مراجعة تطبيق Meta أو رمز.",
      )}
    >
      {notConfigured && (
        <div className="muted" style={{ fontSize: 12 }}>
          {tx(
            "Zernio isn't configured yet — set ZERNIO_API_KEY on the backend.",
            "لم تتم تهيئة Zernio بعد — اضبط ZERNIO_API_KEY في الخادم.",
          )}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {PLATFORMS.map((p) => {
          const acc = accountFor(p.key);
          const connected = !!acc;
          const rowBusy = busy === p.key;
          return (
            <div
              key={p.key}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "10px 12px",
                background: "var(--bg-2)",
                borderRadius: 10,
              }}
            >
              <span
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 8,
                  background: p.color,
                  display: "grid",
                  placeItems: "center",
                  color: p.key === "snapchat" ? "#000" : "#fff",
                  flexShrink: 0,
                }}
              >
                <IconGlobe w={16} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500, fontSize: 13 }}>{p.label}</div>
                <div className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
                  {connected
                    ? `${tx("Connected", "متصل")}${acc?.name ? ` · ${acc.name}` : ""}`
                    : p.note
                      ? p.note(tx)
                      : tx("Not connected", "غير متصل")}
                </div>
              </div>
              {connected ? (
                <Badge kind="ok" dot>
                  {tx("Live", "حي")}
                </Badge>
              ) : p.beta ? (
                <Badge kind="">{tx("Beta", "تجريبي")}</Badge>
              ) : (
                <Badge kind="">{tx("Off", "غير مفعل")}</Badge>
              )}
              {canEdit && (
                <div style={{ flexShrink: 0 }}>
                  {connected ? (
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={() => onDisconnect(p.key)}
                      disabled={rowBusy}
                      style={{ color: "var(--bad)" }}
                    >
                      <IconX w={12} />
                      {rowBusy ? tx("…", "…") : tx("Disconnect", "فصل")}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn primary sm"
                      onClick={() => onConnect(p.key)}
                      disabled={rowBusy || p.beta}
                      title={p.beta ? tx("Not yet available on Zernio.", "غير متاح بعد على Zernio.") : undefined}
                    >
                      {rowBusy ? tx("Opening…", "جارٍ الفتح…") : tx("Connect", "ربط")}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <ErrorRow message={error} />
      {!canEdit && (
        <div className="muted" style={{ fontSize: 11 }}>
          {tx(
            "Only owners and admins can connect integrations.",
            "المالك والمشرف فقط يمكنهم ربط التكاملات.",
          )}
        </div>
      )}
      <StatusToast message={status} />
    </SettingsCard>
  );
}
