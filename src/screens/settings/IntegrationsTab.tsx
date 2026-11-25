import { useEffect, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { useAuth } from "@/auth/context";
import { usePermissions } from "@/auth/usePermissions";
import { useFetch, useMutation } from "@/api/useFetch";
import { api } from "@/api/client";
import { Badge } from "@/components/Badge";
import { IconGlobe, IconCheck, IconX, IconArrow } from "@/icons";
import { ErrorRow, SettingsCard, StatusToast } from "./form";
import { McpAccessCard } from "./McpAccessCard";
import { useConnectFlow } from "@/embed/useConnectFlow";
import { useMetaConfig } from "./MetaConnect";
import { popupAvailable } from "./metaConnectLogic";

// Facebook/Instagram now connect through Zernio instead of our own Meta app —
// no App Review, no Tester enrollment. The legacy Meta-app cards are kept in
// this file behind this flag so we can roll back instantly if needed.
const SHOW_META_LEGACY = false;

interface FbStatus {
  connected: boolean;
  pageId?: string;
  pageName?: string;
  expiresAt?: string;
  lastFetchedAt?: string;
}

export function IntegrationsTab() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const { activeWorkspace } = useAuth();
  const { can } = usePermissions();
  const canEdit = can("channels.update");
  const canConnect = can("channels.create");
  const canView = can("channels.view");
  const canDisconnect = can("channels.delete");
  const canCreateKey = can("api_keys.create");
  const canDeleteKey = can("api_keys.delete");
  // Force a remount of every integration card whenever the active workspace
  // changes so each card refetches /integrations/*/status for the new tenant
  // instead of showing the previous workspace's connected state.
  const wsKey = activeWorkspace?.id ?? "none";
  // Tech Provider: once the switch is on, our own Meta FB/IG cards come back
  // for workspaces that don't already have Facebook through Zernio.
  const metaCfg = useMetaConfig();
  const showMetaFb = SHOW_META_LEGACY || popupAvailable(metaCfg.data, "facebook");

  return (
    <>
      {/* SP-19: WhatsApp numbers, Zernio accounts (Facebook, Instagram,
          TikTok, WhatsApp), Telegram and website chat live in the channels hub. */}
      {canView && <ChannelsMovedCard tx={tx} />}

      {/* Legacy Meta-app FB/IG cards — dormant, kept for rollback (see flag). */}
      {showMetaFb && <FacebookCard key={`fb-${wsKey}`} tx={tx} canEdit={canEdit} canConnect={canConnect} canDisconnect={canDisconnect} />}
      {showMetaFb && <InstagramCard key={`ig-${wsKey}`} tx={tx} />}

      <McpAccessCard key={`mcp-${wsKey}`} tx={tx} canCreate={canCreateKey} canDelete={canDeleteKey} />
    </>
  );
}

/* ─── Channels moved to the hub ──────────────────────────────────── */

function ChannelsMovedCard({ tx }: { tx: (en: string, ar: string) => string }) {
  return (
    <SettingsCard
      title={tx("Channels moved", "انتقلت القنوات")}
      description={tx(
        "WhatsApp numbers, Facebook, Instagram, TikTok, Telegram and website chat are now connected and managed in Channels.",
        "أصبح ربط أرقام واتساب وفيسبوك وإنستغرام وتيك توك وتيليجرام ودردشة الموقع وإدارتها من صفحة القنوات.",
      )}
    >
      <a href="#/channels" className="btn primary" style={{ alignSelf: "flex-start", textDecoration: "none" }}>
        {tx("Open Channels", "افتح القنوات")}
        <IconArrow w={13} />
      </a>
    </SettingsCard>
  );
}

/* ─── Facebook (live) ─────────────────────────────────────────────── */

interface FacebookCardProps {
  tx: (en: string, ar: string) => string;
  canEdit: boolean;
  canConnect: boolean;
  canDisconnect: boolean;
}

function FacebookCard({ tx, canEdit, canConnect, canDisconnect }: FacebookCardProps) {
  const statusQ = useFetch<FbStatus>("/integrations/facebook/status");
  const [status, setStatus] = useState<string | null>(null);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const connect = useConnectFlow();

  const disconnectMut = useMutation<Record<string, never>, { ok: true }>(() =>
    api.delete("/integrations/facebook/disconnect"),
  );
  const resubscribeMut = useMutation<Record<string, never>, { ok: boolean; error?: string }>(
    () => api.post("/integrations/facebook/resubscribe-webhook", {}),
  );

  const connected = statusQ.data?.connected === true;

  // Detect OAuth callback redirect (?fb=connected or ?fb=error&msg=...) and show toast.
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const fb = sp.get("fb");
    if (!fb) return;
    if (fb === "connected") {
      setStatus(tx("Facebook connected.", "تم الاتصال بفيسبوك."));
      statusQ.refetch();
      window.setTimeout(() => setStatus(null), 2400);
    } else if (fb === "error") {
      setOauthError(sp.get("msg") ?? tx("Connection failed.", "فشل الاتصال."));
    }
    // Clean the URL so a refresh doesn't re-fire the toast.
    sp.delete("fb");
    sp.delete("msg");
    const cleaned = sp.toString();
    const newUrl = window.location.pathname + (cleaned ? `?${cleaned}` : "");
    window.history.replaceState({}, "", newUrl);
    // statusQ omitted on purpose; we only run this once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onConnect = async () => {
    setOauthError(null);
    setStarting(true);
    try {
      await connect(async () => {
        const { url } = await api.get<{ url: string }>("/integrations/facebook/oauth/start");
        return url;
      });
      setStarting(false);
    } catch (e) {
      setOauthError((e as Error).message);
      setStarting(false);
    }
  };

  const onDisconnect = async () => {
    if (
      !window.confirm(
        tx(
          "Disconnect Facebook? Live posts and comments will stop syncing.",
          "فصل فيسبوك؟ ستتوقف مزامنة المنشورات والتعليقات.",
        ),
      )
    ) {
      return;
    }
    await disconnectMut.mutate({});
    statusQ.refetch();
    setStatus(tx("Facebook disconnected.", "تم الفصل."));
    window.setTimeout(() => setStatus(null), 2400);
  };

  return (
    <>
      <SettingsCard
        title={tx("Facebook Page", "صفحة فيسبوك")}
        description={tx(
          "Connect your Facebook Page to bring posts, comments, and Messenger threads into Kewy Marketing.",
          "اربط صفحتك على فيسبوك لجلب المنشورات والتعليقات والرسائل.",
        )}
      >
        {/* Status row */}
        <div
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
              background: "#1877F2",
              display: "grid",
              placeItems: "center",
              color: "#fff",
            }}
          >
            <IconGlobe w={16} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 500, fontSize: 13 }}>Facebook</div>
            <div className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
              {connected
                ? `${tx("Connected to", "متصل بـ")} ${statusQ.data?.pageName ?? "Page"}`
                : tx("Not connected", "غير متصل")}
            </div>
          </div>
          {connected ? (
            <Badge kind="ok" dot>
              {tx("Live", "حي")}
            </Badge>
          ) : (
            <Badge kind="">{tx("Off", "غير مفعل")}</Badge>
          )}
        </div>

        {/* Connect — single button that kicks off OAuth */}
        {!connected && canConnect && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="muted" style={{ fontSize: 11 }}>
              {tx(
                "We use Facebook Login to securely access your Page on your behalf. You'll be redirected to facebook.com to approve.",
                "نستخدم تسجيل الدخول بفيسبوك للوصول الآمن إلى صفحتك. سيتم تحويلك إلى facebook.com للموافقة.",
              )}
            </div>
            <ErrorRow message={oauthError} />
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button
                type="button"
                className="btn primary"
                onClick={onConnect}
                disabled={starting}
              >
                <IconCheck w={12} />
                {starting
                  ? tx("Redirecting…", "جارٍ التحويل…")
                  : tx("Connect Facebook", "اربط فيسبوك")}
              </button>
            </div>
          </div>
        )}

        {connected && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {statusQ.data?.expiresAt && (
              <div className="muted" style={{ fontSize: 11 }}>
                {tx("Token expires", "صلاحية الرمز")}:{" "}
                {new Date(statusQ.data.expiresAt).toLocaleDateString()}
              </div>
            )}
            {statusQ.data?.lastFetchedAt && (
              <div className="muted" style={{ fontSize: 11 }}>
                {tx("Last sync", "آخر مزامنة")}:{" "}
                {new Date(statusQ.data.lastFetchedAt).toLocaleString()}
              </div>
            )}
            {(canEdit || canDisconnect) && (
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
                {canEdit && (<button
                  type="button"
                  className="btn ghost sm"
                  onClick={async () => {
                    const r = await resubscribeMut.mutate({});
                    if (r.ok) {
                      setStatus(tx("Webhook subscribed.", "تم تفعيل الويبهوك."));
                    } else {
                      setStatus(
                        tx(`Subscribe failed: ${r.error}`, `فشل: ${r.error}`),
                      );
                    }
                    window.setTimeout(() => setStatus(null), 3500);
                  }}
                  disabled={resubscribeMut.loading}
                  title={tx(
                    "Re-run the Page webhook subscription. Use this if events stop arriving.",
                    "إعادة تشغيل اشتراك الويبهوك للصفحة.",
                  )}
                >
                  {resubscribeMut.loading
                    ? tx("Subscribing…", "جارٍ…")
                    : tx("Resubscribe webhooks", "إعادة اشتراك الويبهوك")}
                </button>)}
                {canDisconnect && (<button
                  type="button"
                  className="btn ghost"
                  onClick={onDisconnect}
                  disabled={disconnectMut.loading}
                  style={{ color: "var(--bad)" }}
                >
                  <IconX w={12} />
                  {disconnectMut.loading
                    ? tx("Disconnecting…", "جارٍ الفصل…")
                    : tx("Disconnect", "فصل")}
                </button>)}
              </div>
            )}
            <ErrorRow message={disconnectMut.error ?? resubscribeMut.error} />
          </div>
        )}

        {!canConnect && !connected && (
          <div className="muted" style={{ fontSize: 11 }}>
            {tx(
              "Only owners and admins can connect integrations.",
              "المالك والمشرف فقط يمكنهم ربط التكاملات.",
            )}
          </div>
        )}
      </SettingsCard>

      <StatusToast message={status} />
    </>
  );
}

/* ─── Instagram (read-only, linked via Facebook OAuth) ───────────── */

interface IgStatus {
  connected: boolean;
  userId?: string;
  username?: string;
  expiresAt?: string | null;
  lastFetchedAt?: string | null;
}

interface InstagramCardProps {
  tx: (en: string, ar: string) => string;
}

function InstagramCard({ tx }: InstagramCardProps) {
  const statusQ = useFetch<IgStatus>("/integrations/instagram/status");
  const connected = statusQ.data?.connected === true;
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [syncErr, setSyncErr] = useState<string | null>(null);

  const onSync = async () => {
    setSyncErr(null);
    setSyncMsg(null);
    setSyncing(true);
    try {
      const r = await api.post<{ ok: true; conversations: number; messages: number }>(
        "/integrations/instagram/sync",
      );
      setSyncMsg(
        tx(
          `Synced ${r.conversations} conversation(s), ${r.messages} message(s).`,
          `تمت المزامنة: ${r.conversations} محادثة و${r.messages} رسالة.`,
        ),
      );
      statusQ.refetch();
      window.setTimeout(() => setSyncMsg(null), 3500);
    } catch (e) {
      setSyncErr((e as Error).message);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <SettingsCard
      title={tx("Instagram", "إنستغرام")}
      description={tx(
        "Instagram Business accounts linked to your Facebook Page connect automatically.",
        "حسابات إنستغرام أعمال المرتبطة بصفحة فيسبوك تتصل تلقائياً.",
      )}
    >
      <div
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
            background:
              "linear-gradient(135deg, #FFDC80 0%, #F77737 25%, #E1306C 50%, #C13584 75%, #5851DB 100%)",
            display: "grid",
            placeItems: "center",
            color: "#fff",
          }}
        >
          <IconGlobe w={16} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 500, fontSize: 13 }}>Instagram</div>
          <div className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
            {connected
              ? `${tx("Connected to", "متصل بـ")} @${statusQ.data?.username ?? "—"}`
              : tx("Not connected", "غير متصل")}
          </div>
        </div>
        {connected ? (
          <Badge kind="ok" dot>
            {tx("Live", "حي")}
          </Badge>
        ) : (
          <Badge kind="">{tx("Off", "غير مفعل")}</Badge>
        )}
      </div>

      {!connected && (
        <div className="muted" style={{ fontSize: 11 }}>
          {tx(
            "To connect: ensure your Facebook Page has a linked Instagram Business account, then reconnect Facebook above.",
            "لربط إنستغرام: تأكد من ربط حساب إنستغرام أعمال بصفحة فيسبوك، ثم أعد ربط فيسبوك بالأعلى.",
          )}
        </div>
      )}

      {connected && statusQ.data?.userId && (
        <div className="muted" style={{ fontSize: 11 }}>
          {tx("Instagram ID", "معرف إنستغرام")}:{" "}
          <span className="mono">{statusQ.data.userId}</span>
        </div>
      )}

      {connected && (
        <>
          <ErrorRow message={syncErr} />
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 10,
            }}
          >
            <span className="muted" style={{ fontSize: 11 }}>
              {syncMsg ?? tx(
                "Pull existing Instagram DMs into the Inbox.",
                "اسحب رسائل إنستغرام إلى صندوق الوارد.",
              )}
            </span>
            <button
              type="button"
              className="btn ghost"
              onClick={onSync}
              disabled={syncing}
            >
              {syncing
                ? tx("Syncing…", "جارٍ المزامنة…")
                : tx("Sync conversations", "مزامنة المحادثات")}
            </button>
          </div>
        </>
      )}
    </SettingsCard>
  );
}

