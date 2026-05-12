import { useState } from "react";
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

      <PlaceholderCard
        tx={tx}
        title={tx("WhatsApp Business", "واتساب الأعمال")}
        description={tx(
          "Connect your WhatsApp Business number via Meta Cloud API to handle customer chats.",
          "اربط رقم واتساب الأعمال عبر Meta Cloud API لإدارة محادثات العملاء.",
        )}
        comingSoonNote={tx(
          "Requires Meta Embedded Signup — pending app review.",
          "يتطلب موافقة ميتا — قيد المراجعة.",
        )}
      />
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
  const [token, setToken] = useState("");
  const [showInput, setShowInput] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const connectMut = useMutation<
    { token: string },
    { connected: boolean; pageId: string; pageName: string; expiresAt: string | null }
  >((input) =>
    api.post("/integrations/facebook/connect", input),
  );

  const disconnectMut = useMutation<Record<string, never>, { ok: true }>(() =>
    api.delete("/integrations/facebook/disconnect"),
  );

  const connected = statusQ.data?.connected === true;

  const onConnect = async () => {
    const tok = token.trim();
    if (!tok) return;
    await connectMut.mutate({ token: tok });
    setToken("");
    setShowInput(false);
    statusQ.refetch();
    setStatus(tx("Facebook connected.", "تم الاتصال بفيسبوك."));
    window.setTimeout(() => setStatus(null), 2400);
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
          "Connect your Facebook Page to bring posts, comments, and Messenger threads into tkana.",
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

        {/* Connect form */}
        {!connected && canEdit && (
          <>
            {showInput ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <Field
                  label={tx("Facebook Page Access Token", "رمز وصول صفحة فيسبوك")}
                  hint={tx(
                    "Generate at developers.facebook.com → Tools → Graph API Explorer → Page Access Token.",
                    "أنشئه من developers.facebook.com → الأدوات → Graph API Explorer.",
                  )}
                >
                  <textarea
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
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
                <ErrorRow message={connectMut.error} />
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={() => {
                      setShowInput(false);
                      setToken("");
                    }}
                  >
                    {tx("Cancel", "إلغاء")}
                  </button>
                  <button
                    type="button"
                    className="btn primary"
                    onClick={onConnect}
                    disabled={connectMut.loading || token.trim().length === 0}
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
                  onClick={() => setShowInput(true)}
                >
                  {tx("Connect Facebook", "اربط فيسبوك")}
                </button>
              </div>
            )}
          </>
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
