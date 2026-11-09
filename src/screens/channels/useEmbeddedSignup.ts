import { useCallback, useEffect, useRef, useState } from "react";
import type { EmbeddedSignupConfig } from "@/lib/types";
import {
  embeddedSignupExtras,
  isFacebookOrigin,
  readSignupSessionEvent,
  signupStep,
  type EmbeddedSignupPayload,
  type SignupInput,
  type SignupIssue,
  type SignupPending,
} from "./embeddedSignupSession";

declare global {
  interface Window {
    FB?: {
      init: (opts: { appId: string; cookie?: boolean; xfbml?: boolean; autoLogAppEvents?: boolean; version: string }) => void;
      login: (
        cb: (resp: { authResponse?: { code?: string; accessToken?: string } | null }) => void,
        opts: {
          config_id: string;
          response_type?: string;
          override_default_response_type?: boolean;
          extras?: object;
        },
      ) => void;
    };
    fbAsyncInit?: () => void;
  }
}

const SDK_ID = "facebook-jssdk";
const SDK_SRC = "https://connect.facebook.net/en_US/sdk.js";
/** How long to wait for the session event after the code before submitting the code alone. */
const SESSION_GRACE_MS = 5000;

/**
 * Loads the Facebook JS SDK, but only when the backend reports the flow as
 * enabled, and initialises it with the backend's appId/graphVersion (no VITE_
 * variables). Returns whether `window.FB` is ready.
 */
function useFacebookSdk(config: EmbeddedSignupConfig | null): boolean {
  const enabled = !!(config?.enabled && config.appId && config.configId);
  const [ready, setReady] = useState(() => enabled && !!window.FB);
  const appId = config?.appId ?? "";
  const version = config?.graphVersion ?? "v21.0";

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const init = () => {
      if (!window.FB) return;
      window.FB.init({ appId, autoLogAppEvents: true, xfbml: false, version });
      if (!cancelled) setReady(true);
    };
    if (window.FB) {
      init();
      return () => {
        cancelled = true;
      };
    }
    window.fbAsyncInit = init;
    if (!document.getElementById(SDK_ID)) {
      const s = document.createElement("script");
      s.id = SDK_ID;
      s.async = true;
      s.defer = true;
      s.crossOrigin = "anonymous";
      s.src = SDK_SRC;
      document.body.appendChild(s);
    }
    return () => {
      cancelled = true;
    };
  }, [enabled, appId, version]);

  return enabled && ready;
}

export type EmbeddedSignupLocalIssue = SignupIssue | { kind: "sdk_unavailable" };

/**
 * Meta Embedded Signup popup driver. The `code` (FB.login callback) and the
 * `WA_EMBEDDED_SIGNUP` session event are joined by `signupStep` in one ref,
 * so either can arrive last; completion fires at most once per launch.
 */
export function useEmbeddedSignup(
  config: EmbeddedSignupConfig | null,
  onComplete: (payload: EmbeddedSignupPayload) => void,
) {
  const ready = useFacebookSdk(config);
  const [popupOpen, setPopupOpen] = useState(false);
  const [issue, setIssue] = useState<EmbeddedSignupLocalIssue | null>(null);
  const pending = useRef<SignupPending>({});
  const timer = useRef<number | null>(null);
  const completeRef = useRef(onComplete);
  completeRef.current = onComplete;

  const clearTimer = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const dispatch = useCallback((input: SignupInput) => {
    const r = signupStep(pending.current, input);
    pending.current = r.pending;
    if (r.issue !== undefined) setIssue(r.issue);
    if (r.complete) {
      clearTimer();
      completeRef.current(r.complete);
    } else if (r.waitForSession) {
      clearTimer();
      timer.current = window.setTimeout(() => {
        timer.current = null;
        dispatch({ type: "session_timeout" });
      }, SESSION_GRACE_MS);
    }
  }, []);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!isFacebookOrigin(e.origin)) return;
      let payload: unknown = e.data;
      if (typeof payload === "string") {
        try {
          payload = JSON.parse(payload);
        } catch {
          return; // xd_arbiter noise
        }
      }
      const event = readSignupSessionEvent(payload);
      if (event) dispatch({ type: "session", event });
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      clearTimer();
    };
  }, [dispatch]);

  const launch = useCallback(() => {
    if (!config?.enabled || !config.configId) return;
    if (!window.FB) {
      setIssue({ kind: "sdk_unavailable" });
      return;
    }
    clearTimer();
    dispatch({ type: "launch" });
    setPopupOpen(true);
    window.FB.login(
      (resp) => {
        setPopupOpen(false);
        dispatch({ type: "code", code: resp?.authResponse?.code ?? null });
      },
      {
        config_id: config.configId,
        response_type: "code",
        override_default_response_type: true,
        extras: embeddedSignupExtras(config.solutionId),
      },
    );
  }, [config?.enabled, config?.configId, config?.solutionId, dispatch]);

  return { ready, launch, popupOpen, issue, clearIssue: () => setIssue(null) };
}
