import { useState } from "react";
import { api } from "@/api/client";
import type { Tx } from "@/lib/tx";
import type { ChannelDto, EmbeddedSignupConfig } from "@/lib/types";
import { channelErrorCopy, channelErrorText } from "./channelErrors";
import { metaErrorReference, type EmbeddedSignupPayload } from "./embeddedSignupSession";
import { Banner, ErrorText } from "./channelUi";
import { useEmbeddedSignup, type EmbeddedSignupLocalIssue } from "./useEmbeddedSignup";

/**
 * "Connect with Meta" (WhatsApp Embedded Signup). Shown only when the backend
 * reports the flow enabled; otherwise the localized reason, plus the missing
 * env names for channels.update holders (the backend only sends them to those).
 * On completion it posts to /channels/whatsapp/embedded-signup; the caller
 * opens the returned channel, whose landline card takes over when it is pending.
 */
export function EmbeddedSignupButton({
  config,
  tx,
  canSeeConfig,
  disabled,
  onConnected,
}: {
  config: EmbeddedSignupConfig | null;
  tx: Tx;
  canSeeConfig: boolean;
  disabled?: boolean;
  onConnected: (c: ChannelDto) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const complete = async (payload: EmbeddedSignupPayload) => {
    setBusy(true);
    setError(null);
    try {
      const c = await api.post<ChannelDto>("/channels/whatsapp/embedded-signup", payload);
      onConnected(c);
    } catch (e) {
      setError(channelErrorText(e, tx));
    } finally {
      setBusy(false);
    }
  };

  const es = useEmbeddedSignup(config, (p) => void complete(p));

  if (!config) return null;

  if (!config.enabled) {
    const reason = channelErrorCopy(config.reason ?? "channels.embedded_signup_not_configured") ?? channelErrorCopy("channels.embedded_signup_not_configured")!;
    return (
      <Banner tone="info" title={tx("Connect with Meta is unavailable", "الربط عبر Meta غير متاح")}>
        {tx(reason.en, reason.ar)}
        {canSeeConfig && config.missing && config.missing.length > 0 && (
          <div style={{ marginBlockStart: 4 }}>
            {tx("Missing server settings: ", "إعدادات الخادم الناقصة: ")}
            {config.missing.map((m, i) => (
              <span key={m}>
                {i > 0 && ", "}
                <code className="mono" dir="ltr">{m}</code>
              </span>
            ))}
          </div>
        )}
      </Banner>
    );
  }

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <button
        type="button"
        className="btn primary"
        style={{ justifySelf: "start", background: "#1877F2", borderColor: "#1877F2", color: "#fff" }}
        disabled={disabled || busy || es.popupOpen || !es.ready}
        onClick={() => {
          setError(null);
          es.launch();
        }}
      >
        {busy
          ? tx("Finishing the connection…", "جارٍ إكمال الربط…")
          : es.popupOpen
            ? tx("Waiting for Meta…", "بانتظار Meta…")
            : !es.ready
              ? tx("Loading Meta…", "جارٍ تحميل Meta…")
              : tx("Connect with Meta", "الربط عبر Meta")}
      </button>
      {es.issue && <IssueText issue={es.issue} tx={tx} />}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

function IssueText({ issue, tx }: { issue: EmbeddedSignupLocalIssue; tx: Tx }) {
  if (issue.kind === "cancelled") {
    return (
      <div className="muted" style={{ fontSize: 12 }}>
        {tx("The Meta window closed before the signup finished. Try again when you're ready.", "أُغلقت نافذة Meta قبل اكتمال التسجيل. حاول مجددًا عندما تكون جاهزًا.")}
      </div>
    );
  }
  if (issue.kind === "no_phone_number") {
    return (
      <ErrorText>
        {tx("Meta finished without a WhatsApp Business account. Run the signup again.", "انتهت Meta دون حساب واتساب للأعمال. أعد التسجيل.")}
      </ErrorText>
    );
  }
  if (issue.kind === "sdk_unavailable") {
    return (
      <ErrorText>
        {tx(
          "Meta's login script didn't load. Check that pop-ups and connect.facebook.net aren't blocked, then reload.",
          "لم يُحمَّل سكربت تسجيل الدخول من Meta. تأكد من عدم حظر النوافذ المنبثقة وconnect.facebook.net ثم أعد التحميل.",
        )}
      </ErrorText>
    );
  }
  const ref = metaErrorReference(issue);
  return (
    <ErrorText>
      {tx("Meta reported an error", "أبلغت Meta عن خطأ")}
      {issue.message ? <>: <bdi>{issue.message}</bdi></> : "."}
      {ref && (
        <>
          {" "}
          {tx("Reference for Meta support: ", "المرجع لدعم Meta: ")}
          <bdi dir="ltr" className="mono">{ref}</bdi>
        </>
      )}
    </ErrorText>
  );
}
