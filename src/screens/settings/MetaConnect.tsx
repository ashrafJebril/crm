import { useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import { useFetch } from "@/api/useFetch";
import { IconCheck } from "@/icons";
import { ErrorRow } from "./form";
import { parseEmbeddedSignupMessage, type EmbeddedSignupEvent, type MetaConfig } from "./metaConnectLogic";

// Facebook JS SDK (script tag in index.html) — only the bits we use.
declare global {
  interface Window {
    FB?: {
      init: (opts: { appId: string; cookie?: boolean; xfbml?: boolean; version: string }) => void;
      login: (
        cb: (resp: { authResponse?: { code?: string; accessToken?: string; userID?: string } | null; status?: string }) => void,
        opts: { config_id: string; response_type: string; override_default_response_type: boolean; extras?: object },
      ) => void;
    };
    fbAsyncInit?: () => void;
  }
}

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

interface Props {
  cfg: MetaConfig;
  tx: (en: string, ar: string) => string;
  onConnected: () => void;
}

/**
 * WhatsApp Embedded Signup. Meta's popup gives us two things on separate
 * channels: the auth `code` (FB.login callback) and the WABA / phone ids
 * (a window `message` event). We wait for both, then let the backend finish.
 */
export function WhatsAppPopupConnect({ cfg, tx, onConnected }: Props) {
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

  const finish = async (code: string | undefined, userID: string | undefined) => {
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
      await api.post("/integrations/whatsapp/oauth/exchange", {
        code,
        phoneNumberId: ev.phoneNumberId,
        wabaId: ev.wabaId,
        ...(userID ? { metaUserId: userID } : {}),
      });
      onConnected();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onClick = () => {
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
        void finish(resp.authResponse?.code, resp.authResponse?.userID);
      },
      {
        config_id: cfg.waConfigId,
        response_type: "code",
        override_default_response_type: true,
        extras: { setup: {}, featureType: "", sessionInfoVersion: "3" },
      },
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <button type="button" className="btn primary" style={{ alignSelf: "flex-start" }} onClick={onClick} disabled={busy}>
        <IconCheck w={12} />
        {busy ? tx("Connecting…", "جارٍ الاتصال…") : tx("Connect with Meta", "اتصل عبر Meta")}
      </button>
      <ErrorRow message={error} />
      <div className="muted" style={{ fontSize: 11 }}>
        {tx("Or use an access token instead:", "أو استخدم رمز وصول بدلاً من ذلك:")}
      </div>
    </div>
  );
}
