import { useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import { useFetch } from "@/api/useFetch";
import { IconCheck } from "@/icons";
import { ErrorRow } from "./form";
import { parseEmbeddedSignupMessage, type EmbeddedSignupEvent, type MetaConfig } from "./metaConnectLogic";
import type { ChannelDto } from "@/lib/types";

// The Facebook JS SDK and its `window.FB` typing live in
// channels/useEmbeddedSignup.ts, which loads the script.

/** Tech Provider config for this workspace (switch, app id, login configs, Zernio flags). */
export function useMetaConfig() {
  return useFetch<MetaConfig>("/integrations/meta/config");
}

let initedAppId: string | null = null;

/** Init the FB SDK for `appId` once it has loaded. Safe to call repeatedly. */
function ensureFbInit(appId: string, version: string) {
  const run = () => {
    if (!window.FB || initedAppId === appId) return;
    window.FB.init({ appId, cookie: true, xfbml: false, version });
    initedAppId = appId;
  };
  if (window.FB) run();
  else {
    const prev = window.fbAsyncInit;
    window.fbAsyncInit = () => {
      prev?.();
      run();
    };
  }
}

type SignupMode = "cloud" | "coexistence";

interface Props {
  cfg: MetaConfig;
  tx: (en: string, ar: string) => string;
  onConnected: (c: ChannelDto) => void;
  /** "coexistence" hides the Cloud API button (the channels hub has its own). */
  only?: SignupMode;
  disabled?: boolean;
}

/**
 * WhatsApp Embedded Signup. Meta's popup gives us two things on separate
 * channels: the auth `code` (FB.login callback) and the WABA / phone ids
 * (a window `message` event). We wait for both, then let the backend finish.
 */
export function WhatsAppPopupConnect({ cfg, tx, onConnected, only, disabled }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signupRef = useRef<EmbeddedSignupEvent | null>(null);

  useEffect(() => {
    if (cfg.appId) ensureFbInit(cfg.appId, cfg.graphVersion ?? "v21.0");
  }, [cfg.appId, cfg.graphVersion]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const ev = parseEmbeddedSignupMessage(e.origin, e.data);
      if (ev) signupRef.current = ev;
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  /** The ids message can land just after the login callback — give it a moment. */
  const waitForSignupEvent = async (): Promise<EmbeddedSignupEvent | null> => {
    for (let i = 0; i < 25 && !signupRef.current; i++) {
      await new Promise((r) => setTimeout(r, 200));
    }
    return signupRef.current;
  };

  const finish = async (code: string | undefined, userID: string | undefined, mode: SignupMode) => {
    try {
      if (!code) {
        setError(null); // closed / cancelled the popup — not an error
        return;
      }
      const ev = await waitForSignupEvent();
      if (!ev || ev.kind === "cancel") {
        setError(tx("Setup wasn't finished in the Meta window.", "لم يكتمل الإعداد في نافذة Meta."));
        return;
      }
      if (ev.kind === "error") {
        setError(ev.message);
        return;
      }
      if (!ev.phoneNumberId) {
        setError(
          tx(
            "Your WhatsApp account was created but no phone number was added. Add a number in WhatsApp Manager, then connect again.",
            "تم إنشاء حساب واتساب لكن لم تتم إضافة رقم. أضف رقمًا في إدارة واتساب ثم اتصل مرة أخرى.",
          ),
        );
        return;
      }
      const channel = await api.post<ChannelDto>("/integrations/whatsapp/oauth/exchange", {
        code,
        phoneNumberId: ev.phoneNumberId,
        wabaId: ev.wabaId,
        mode,
        ...(userID ? { metaUserId: userID } : {}),
      });
      onConnected(channel);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onClick = (mode: SignupMode) => {
    setError(null);
    signupRef.current = null;
    if (!window.FB || !cfg.appId || !cfg.waConfigId) {
      setError(tx("Meta login is still loading — try again in a moment.", "تسجيل الدخول بميتا قيد التحميل — حاول بعد لحظة."));
      return;
    }
    ensureFbInit(cfg.appId, cfg.graphVersion ?? "v21.0");
    setBusy(true);
    // Must run synchronously inside the click handler or the popup is blocked.
    window.FB.login(
      (resp) => {
        void finish(resp.authResponse?.code, resp.authResponse?.userID, mode);
      },
      {
        config_id: cfg.waConfigId,
        response_type: "code",
        override_default_response_type: true,
        // "whatsapp_business_app_onboarding" = coexistence: the customer scans
        // a QR code in the WhatsApp Business app and keeps using it.
        extras: {
          setup: {},
          featureType: mode === "coexistence" ? "whatsapp_business_app_onboarding" : "",
          sessionInfoVersion: "3",
        },
      },
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" className="btn primary" onClick={() => onClick("coexistence")} disabled={busy || disabled}>
          <IconCheck w={12} />
          {busy
            ? tx("Connecting…", "جارٍ الاتصال…")
            : tx("Connect my WhatsApp Business app", "ربط تطبيق واتساب للأعمال")}
        </button>
        {only !== "coexistence" && (
          <button type="button" className="btn" onClick={() => onClick("cloud")} disabled={busy || disabled}>
            {tx("Use a new number", "استخدام رقم جديد")}
          </button>
        )}
      </div>
      <div className="muted" style={{ fontSize: 11 }}>
        {tx(
          "Keep using the WhatsApp Business app on your phone — you'll scan a QR code to link it. Your last 6 months of chats are imported.",
          "استمر في استخدام تطبيق واتساب للأعمال على هاتفك — ستمسح رمز QR لربطه. يتم استيراد محادثات آخر 6 أشهر.",
        )}
      </div>
      <ErrorRow message={error} />
    </div>
  );
}
