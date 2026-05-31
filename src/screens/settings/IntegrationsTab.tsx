import { useEffect, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { useAuth } from "@/auth/context";
import { useFetch, useMutation } from "@/api/useFetch";
import { api } from "@/api/client";
import { Badge } from "@/components/Badge";
import { IconGlobe, IconCheck, IconX } from "@/icons";
import { ErrorRow, Field, SettingsCard, StatusToast, inputStyle } from "./form";

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
  const canEdit = activeWorkspace?.role === "owner" || activeWorkspace?.role === "admin";

  return (
    <>
      <FacebookCard tx={tx} canEdit={canEdit} />

      <PlaceholderCard
        tx={tx}
        title={tx("Instagram", "إنستغرام")}
        description={tx(
          "Connect an Instagram Business account to receive DMs and pull hashtag mentions.",
          "اربط حساب إنستغرام أعمال لاستقبال الرسائل ومتابعة الهاشتاجات.",
        )}
        comingSoonNote={tx(
          "Available once your Meta business is verified.",
          "متوفر بعد التحقق من حساب ميتا بزنس.",
        )}
      />

      <PlaceholderCard
        tx={tx}
        title={tx("TikTok", "تيك توك")}
        description={tx(
          "Read comments on your TikTok posts and respond from the Inbox.",
          "اقرأ التعليقات على منشورات تيك توك ورد من صندوق الرسائل.",
        )}
        comingSoonNote={tx("Coming soon.", "قريباً.")}
      />

      <WhatsAppCard tx={tx} canEdit={canEdit} />
    </>
  );
}

/* ─── WhatsApp (live) ────────────────────────────────────────────── */

interface WaStatus {
  connected: boolean;
  phoneNumberId?: string;
  displayPhoneNumber?: string | null;
  wabaId?: string;
  verifyToken?: string;
  expiresAt?: string | null;
  lastFetchedAt?: string | null;
}

interface WhatsAppCardProps {
  tx: (en: string, ar: string) => string;
  canEdit: boolean;
}

function WhatsAppCard({ tx, canEdit }: WhatsAppCardProps) {
  const statusQ = useFetch<WaStatus>("/integrations/whatsapp/status");
  const [showForm, setShowForm] = useState(false);
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [wabaId, setWabaId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [verifyToken, setVerifyToken] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  const connectMut = useMutation<
    {
      phoneNumberId: string;
      wabaId: string;
      accessToken: string;
      verifyToken: string;
    },
    WaStatus
  >((input) => api.post("/integrations/whatsapp/connect", input));

  const disconnectMut = useMutation<Record<string, never>, { ok: true }>(() =>
    api.delete("/integrations/whatsapp/disconnect"),
  );

  const connected = statusQ.data?.connected === true;

  const onConnect = async () => {
    await connectMut.mutate({
      phoneNumberId: phoneNumberId.trim(),
      wabaId: wabaId.trim(),
      accessToken: accessToken.trim(),
      verifyToken: verifyToken.trim(),
    });
    setPhoneNumberId("");
    setWabaId("");
    setAccessToken("");
    setVerifyToken("");
    setShowForm(false);
    statusQ.refetch();
    setStatus(tx("WhatsApp connected.", "تم الاتصال بواتساب."));
    window.setTimeout(() => setStatus(null), 2400);
  };

  const onDisconnect = async () => {
    if (
      !window.confirm(
        tx(
          "Disconnect WhatsApp? Inbound messages will stop being received.",
          "فصل واتساب؟ ستتوقف الرسائل الواردة.",
        ),
      )
    ) {
      return;
    }
    await disconnectMut.mutate({});
    statusQ.refetch();
    setStatus(tx("WhatsApp disconnected.", "تم الفصل."));
    window.setTimeout(() => setStatus(null), 2400);
  };

  const canSubmit =
    phoneNumberId.trim().length > 0 &&
    wabaId.trim().length > 0 &&
    accessToken.trim().length >= 20 &&
    verifyToken.trim().length > 0;

  return (
    <>
      <SettingsCard
        title={tx("WhatsApp Business", "واتساب الأعمال")}
        description={tx(
          "Connect your WhatsApp Business number via Meta Cloud API to handle customer chats.",
          "اربط رقم واتساب الأعمال عبر Meta Cloud API لإدارة محادثات العملاء.",
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
              background: "#25D366",
              display: "grid",
              placeItems: "center",
              color: "#fff",
            }}
          >
            <IconGlobe w={16} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 500, fontSize: 13 }}>WhatsApp</div>
            <div className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
              {connected
                ? `${tx("Connected to", "متصل بـ")} ${statusQ.data?.displayPhoneNumber ?? statusQ.data?.phoneNumberId ?? ""}`
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

        {/* Connect form */}
        {!connected && canEdit && (
          <>
            {showForm ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <Field
                  label={tx("Phone Number ID", "معرف رقم الهاتف")}
                  hint={tx(
                    "From Meta → WhatsApp → API Setup → Phone number ID.",
                    "من Meta → واتساب → إعداد API → معرف رقم الهاتف.",
                  )}
                >
                  <input
                    value={phoneNumberId}
                    onChange={(e) => setPhoneNumberId(e.target.value)}
                    placeholder="1065134116690789"
                    style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
                  />
                </Field>
                <Field
                  label={tx("WhatsApp Business Account ID", "معرف حساب واتساب الأعمال")}
                  hint={tx(
                    "Same page — labeled 'WhatsApp Business Account ID'.",
                    "نفس الصفحة — 'معرف حساب واتساب الأعمال'.",
                  )}
                >
                  <input
                    value={wabaId}
                    onChange={(e) => setWabaId(e.target.value)}
                    placeholder="979108491142803"
                    style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
                  />
                </Field>
                <Field
                  label={tx("Access Token", "رمز الوصول")}
                  hint={tx(
                    "Permanent System User token (preferred) or temporary 24-hour token from API Setup.",
                    "رمز مستخدم النظام الدائم (مفضل) أو الرمز المؤقت.",
                  )}
                >
                  <textarea
                    value={accessToken}
                    onChange={(e) => setAccessToken(e.target.value)}
                    placeholder="EAAB..."
                    rows={3}
                    style={{
                      ...inputStyle,
                      height: "auto",
                      padding: "10px 12px",
                      fontFamily: "var(--font-mono)",
                      fontSize: 11,
                      resize: "vertical",
                    }}
                  />
                </Field>
                <Field
                  label={tx("Verify Token", "رمز التحقق")}
                  hint={tx(
                    "Any random string. Paste the same value into Meta's webhook setup.",
                    "أي نص عشوائي. الصق نفس القيمة في إعداد webhook بميتا.",
                  )}
                >
                  <input
                    value={verifyToken}
                    onChange={(e) => setVerifyToken(e.target.value)}
                    placeholder="aram-x9k2m7"
                    style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
                  />
                </Field>
                <ErrorRow message={connectMut.error} />
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={() => {
                      setShowForm(false);
                      setPhoneNumberId("");
                      setWabaId("");
                      setAccessToken("");
                      setVerifyToken("");
                    }}
                  >
                    {tx("Cancel", "إلغاء")}
                  </button>
                  <button
                    type="button"
                    className="btn primary"
                    onClick={onConnect}
                    disabled={connectMut.loading || !canSubmit}
                  >
                    <IconCheck w={12} />
                    {connectMut.loading
                      ? tx("Connecting…", "جارٍ الاتصال…")
                      : tx("Connect", "اتصال")}
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => setShowForm(true)}
                >
                  {tx("Connect WhatsApp", "اربط واتساب")}
                </button>
              </div>
            )}
          </>
        )}

        {connected && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {statusQ.data?.wabaId && (
              <div className="muted" style={{ fontSize: 11 }}>
                {tx("WABA ID", "معرف WABA")}:{" "}
                <span className="mono">{statusQ.data.wabaId}</span>
              </div>
            )}
            {statusQ.data?.lastFetchedAt && (
              <div className="muted" style={{ fontSize: 11 }}>
                {tx("Last activity", "آخر نشاط")}:{" "}
                {new Date(statusQ.data.lastFetchedAt).toLocaleString()}
              </div>
            )}
            {canEdit && (
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 4 }}>
                <button
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
                </button>
              </div>
            )}
            <ErrorRow message={disconnectMut.error} />
          </div>
        )}

        {!canEdit && !connected && (
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

/* ─── Facebook (live) ─────────────────────────────────────────────── */

interface FacebookCardProps {
  tx: (en: string, ar: string) => string;
  canEdit: boolean;
}

function FacebookCard({ tx, canEdit }: FacebookCardProps) {
  const statusQ = useFetch<FbStatus>("/integrations/facebook/status");
  const [status, setStatus] = useState<string | null>(null);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const disconnectMut = useMutation<Record<string, never>, { ok: true }>(() =>
    api.delete("/integrations/facebook/disconnect"),
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
      const { url } = await api.get<{ url: string }>("/integrations/facebook/oauth/start");
      window.location.href = url;
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
          "Connect your Facebook Page to bring posts, comments, and Messenger threads into Aram.",
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
        {!connected && canEdit && (
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
            {canEdit && (
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 4 }}>
                <button
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
                </button>
              </div>
            )}
            <ErrorRow message={disconnectMut.error} />
          </div>
        )}

        {!canEdit && !connected && (
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

/* ─── "Coming soon" placeholder ──────────────────────────────────── */

interface PlaceholderCardProps {
  tx: (en: string, ar: string) => string;
  title: string;
  description: string;
  comingSoonNote: string;
}

function PlaceholderCard({ tx, title, description, comingSoonNote }: PlaceholderCardProps) {
  return (
    <SettingsCard title={title} description={description}>
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
            background: "var(--line-soft)",
            display: "grid",
            placeItems: "center",
          }}
        >
          <IconGlobe w={16} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 500, fontSize: 13 }}>{title}</div>
          <div className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
            {tx("Not connected", "غير متصل")}
          </div>
        </div>
        <Badge kind="">{tx("Coming soon", "قريباً")}</Badge>
      </div>
      <div className="muted" style={{ fontSize: 11 }}>
        {comingSoonNote}
      </div>
    </SettingsCard>
  );
}
