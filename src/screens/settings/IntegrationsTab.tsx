import { useEffect, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { useAuth } from "@/auth/context";
import { useFetch, useMutation } from "@/api/useFetch";
import { api } from "@/api/client";
import { Badge } from "@/components/Badge";
import { IconGlobe, IconCheck, IconX } from "@/icons";
import { ErrorRow, Field, SettingsCard, StatusToast, inputStyle } from "./form";
import { KapsoCard } from "./KapsoCard";

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
  // Force a remount of every integration card whenever the active workspace
  // changes so each card refetches /integrations/*/status for the new tenant
  // instead of showing the previous workspace's connected state.
  const wsKey = activeWorkspace?.id ?? "none";

  return (
    <>
      <FacebookCard key={`fb-${wsKey}`} tx={tx} canEdit={canEdit} />

      <InstagramCard key={`ig-${wsKey}`} tx={tx} />

      <PlaceholderCard
        tx={tx}
        title={tx("TikTok", "تيك توك")}
        description={tx(
          "Read comments on your TikTok posts and respond from the Inbox.",
          "اقرأ التعليقات على منشورات تيك توك ورد من صندوق الرسائل.",
        )}
        comingSoonNote={tx("Coming soon.", "قريباً.")}
      />

      <WhatsAppCard key={`wa-${wsKey}`} tx={tx} canEdit={canEdit} />

      <KapsoCard key={`kapso-${wsKey}`} tx={tx} canEdit={canEdit} />
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

// Augment window with the Facebook SDK shape we use for Embedded Signup.
declare global {
  interface Window {
    FB?: {
      init: (opts: { appId: string; cookie?: boolean; xfbml?: boolean; version: string }) => void;
      login: (
        cb: (resp: { authResponse?: { code?: string; accessToken?: string } | null }) => void,
        opts: { config_id: string; response_type: string; override_default_response_type: boolean; extras?: object },
      ) => void;
    };
    fbAsyncInit?: () => void;
  }
}

function WhatsAppCard({ tx, canEdit }: WhatsAppCardProps) {
  const statusQ = useFetch<WaStatus>("/integrations/whatsapp/status");
  const [showForm, setShowForm] = useState(false);
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [wabaId, setWabaId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [verifyToken, setVerifyToken] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [esError] = useState<string | null>(null);

  const connectMut = useMutation<
    {
      phoneNumberId: string;
      wabaId: string;
      accessToken: string;
      verifyToken: string;
    },
    WaStatus
  >((input) => api.post("/integrations/whatsapp/connect", input));

  // One-field connect: customer pastes their access token, backend discovers
  // the WABA + phone number via Graph and saves. This is the primary path —
  // Meta's Embedded Signup popup requires Tech Provider status which isn't
  // available for most direct integrators.
  const [tokenOnly, setTokenOnly] = useState("");
  const connectByTokenMut = useMutation<{ accessToken: string }, WaStatus>(
    (input) => api.post("/integrations/whatsapp/connect-by-token", input),
  );

  const disconnectMut = useMutation<Record<string, never>, { ok: true }>(() =>
    api.delete("/integrations/whatsapp/disconnect"),
  );

  const connected = statusQ.data?.connected === true;

  // Initialize Facebook SDK once (the script tag is in index.html).
  useEffect(() => {
    const appId = import.meta.env.VITE_WA_APP_ID as string | undefined;
    if (!appId) return;
    const init = () => {
      if (window.FB) {
        window.FB.init({
          appId,
          cookie: true,
          xfbml: true,
          version: "v21.0",
        });
      }
    };
    if (window.FB) {
      init();
    } else {
      window.fbAsyncInit = init;
    }
  }, []);

  // Listen for Embedded Signup window.message events to capture phone_number_id + waba_id.
  const wasigRef = useState<{ phoneNumberId?: string; wabaId?: string }>({})[0];
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (
        event.origin !== "https://www.facebook.com" &&
        event.origin !== "https://web.facebook.com"
      ) {
        return;
      }
      try {
        const data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
        if (data?.type === "WA_EMBEDDED_SIGNUP") {
          if (data.event === "FINISH" || data.event === "FINISH_ONLY_WABA") {
            wasigRef.phoneNumberId = data.data?.phone_number_id;
            wasigRef.wabaId = data.data?.waba_id;
          }
        }
      } catch {
        /* not JSON */
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [wasigRef]);

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

  const onConnectByToken = async () => {
    const token = tokenOnly.trim();
    if (token.length < 20) return;
    await connectByTokenMut.mutate({ accessToken: token });
    setTokenOnly("");
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
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ fontSize: 12, color: "var(--ink-2)", lineHeight: 1.5 }}>
                  <div style={{ fontWeight: 500, color: "var(--ink-1)", marginBottom: 4 }}>
                    {tx(
                      "Two-step setup:",
                      "خطوتان فقط:",
                    )}
                  </div>
                  <ol
                    style={{
                      margin: 0,
                      paddingInlineStart: 18,
                      display: "flex",
                      flexDirection: "column",
                      gap: 4,
                    }}
                  >
                    <li>
                      {tx(
                        "Open Meta's WhatsApp API Setup, copy the temporary access token.",
                        "افتح إعداد API لواتساب في Meta وانسخ رمز الوصول المؤقت.",
                      )}
                    </li>
                    <li>
                      {tx(
                        "Paste the token below and click Connect. Aram discovers your phone number and WABA automatically.",
                        "الصق الرمز أدناه واضغط 'اتصال'. سيكتشف Aram رقمك ومعرف WABA تلقائيًا.",
                      )}
                    </li>
                  </ol>
                </div>

                <a
                  href="https://business.facebook.com/wa/manage/home/"
                  target="_blank"
                  rel="noreferrer"
                  className="btn"
                  style={{
                    alignSelf: "flex-start",
                    fontSize: 12,
                    textDecoration: "none",
                  }}
                >
                  <IconGlobe w={13} />
                  {tx("Open Meta WhatsApp Manager", "افتح إدارة واتساب في Meta")}
                </a>

                <Field
                  label={tx("Paste your access token", "الصق رمز الوصول")}
                  hint={tx(
                    "From WhatsApp Manager → API Setup → 'Temporary access token'. Starts with EAA…",
                    "من إعداد API → 'رمز الوصول المؤقت'. يبدأ بـ EAA…",
                  )}
                >
                  <textarea
                    value={tokenOnly}
                    onChange={(e) => setTokenOnly(e.target.value)}
                    placeholder="EAAR..."
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

                <ErrorRow message={connectByTokenMut.error ?? esError} />

                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => setShowForm(true)}
                    title={tx(
                      "I have multiple WABAs or want to paste all 3 IDs manually",
                      "لدي عدة حسابات WABA أو أريد لصق كل المعرفات يدويًا",
                    )}
                  >
                    {tx("Advanced setup", "إعداد متقدم")}
                  </button>
                  <button
                    type="button"
                    className="btn primary"
                    onClick={onConnectByToken}
                    disabled={
                      connectByTokenMut.loading || tokenOnly.trim().length < 20
                    }
                  >
                    <IconCheck w={12} />
                    {connectByTokenMut.loading
                      ? tx("Connecting…", "جارٍ الاتصال…")
                      : tx("Connect", "اتصال")}
                  </button>
                </div>
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
            {statusQ.data?.verifyToken && (
              <div
                style={{
                  marginTop: 4,
                  padding: "8px 10px",
                  borderRadius: 8,
                  background: "var(--bg-2)",
                  border: "1px solid var(--line-soft)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                }}
              >
                <div
                  className="mono"
                  style={{
                    fontSize: 10,
                    color: "var(--ink-3)",
                    textTransform: "uppercase",
                    letterSpacing: 0.06,
                  }}
                >
                  {tx("Webhook setup", "إعداد Webhook")}
                </div>
                <div style={{ fontSize: 11, color: "var(--ink-2)", lineHeight: 1.4 }}>
                  {tx(
                    "Configure Meta App → WhatsApp → Configuration → Webhook with these values:",
                    "اضبط Meta App → WhatsApp → Configuration → Webhook بهذه القيم:",
                  )}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 10px", fontSize: 11 }}>
                  <span className="muted">{tx("Callback URL", "عنوان الـ Callback")}:</span>
                  <code style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-1)", wordBreak: "break-all" }}>
                    {`<your-public-url>/api/webhooks/whatsapp`}
                  </code>
                  <span className="muted">{tx("Verify Token", "رمز التحقق")}:</span>
                  <code style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-1)", wordBreak: "break-all" }}>
                    {statusQ.data.verifyToken}
                  </code>
                  <span className="muted">{tx("Webhook fields", "حقول Webhook")}:</span>
                  <span style={{ fontSize: 11, color: "var(--ink-2)" }}>
                    {tx("Subscribe to ", "اشترك في ")}
                    <code style={{ fontFamily: "var(--font-mono)" }}>messages</code>
                  </span>
                </div>
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
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
                <button
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
                </button>
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
            <ErrorRow message={disconnectMut.error ?? resubscribeMut.error} />
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
