/**
 * The pure half of Meta's WhatsApp Embedded Signup (ported from Tkana's
 * `embedded-signup-session.ts` / `use-embedded-signup.ts`).
 *
 * A signup produces two things that arrive INDEPENDENTLY and in either order:
 *  - `code`: the FB.login callback;
 *  - the `WA_EMBEDDED_SIGNUP` session event (waba_id, phone_number_id),
 *    posted to the opener window by a facebook.com frame.
 * `signupStep` joins them in one cell (`SignupPending`, held in a ref by the
 * hook) so whichever arrives last completes the signup, at most once per launch.
 */

/** What FB.login gets as `extras`. Coexistence (`featureType`) is out of scope (R6). */
export function embeddedSignupExtras(solutionId: string | undefined | null): { setup: Record<string, string> } {
  return { setup: solutionId ? { solutionID: solutionId } : {} };
}

export type SignupSessionEvent =
  | { kind: "finished"; event: string; wabaId: string | null; phoneNumberId: string | null }
  | { kind: "no_phone_number"; event: string; wabaId: string | null }
  | { kind: "cancelled"; step: string | null }
  | { kind: "error"; errorCode: string | null; sessionId: string | null; message: string | null }
  | { kind: "unknown"; event: string };

function text(value: unknown): string | null {
  if (typeof value === "string") return value || null;
  if (typeof value === "number") return String(value);
  return null;
}

/** Reads one parsed `message` payload; null for anything that is not a signup session event. */
export function readSignupSessionEvent(payload: unknown): SignupSessionEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { type?: unknown; event?: unknown; data?: unknown };
  if (p.type !== "WA_EMBEDDED_SIGNUP") return null;
  const event = String(p.event ?? "");
  const d = (p.data && typeof p.data === "object" ? p.data : {}) as Record<string, unknown>;
  // A user-reported error comes as ERROR, or as a CANCEL carrying error_message.
  if (event === "ERROR" || (event === "CANCEL" && d.error_message != null)) {
    return { kind: "error", errorCode: text(d.error_code), sessionId: text(d.session_id), message: text(d.error_message) };
  }
  if (event === "CANCEL") return { kind: "cancelled", step: text(d.current_step) };
  if (event === "FINISH_ONLY_WABA") return { kind: "no_phone_number", event, wabaId: text(d.waba_id) };
  if (event.startsWith("FINISH")) {
    return { kind: "finished", event, wabaId: text(d.waba_id), phoneNumberId: text(d.phone_number_id) };
  }
  return { kind: "unknown", event };
}

/** The reference Meta support asks for, e.g. "#4563039:01a0f379-…". */
export function metaErrorReference(e: { errorCode: string | null; sessionId: string | null }): string | null {
  if (!e.errorCode && !e.sessionId) return null;
  return `#${e.errorCode ?? "N/A"}:${e.sessionId ?? "N/A"}`;
}

/** Session events are trusted only from facebook.com frames. */
export function isFacebookOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  return url.hostname === "facebook.com" || url.hostname.endsWith(".facebook.com");
}

/** Body of `POST /channels/whatsapp/embedded-signup` (T4 contract). */
export interface EmbeddedSignupPayload {
  code: string;
  wabaId?: string;
  phoneNumberId?: string;
  signupEvent?: "FINISH" | "FINISH_ONLY_WABA";
}

export type SignupIssue =
  | { kind: "cancelled"; step: string | null }
  | { kind: "error"; errorCode: string | null; sessionId: string | null; message: string | null }
  | { kind: "no_phone_number" };

export interface SignupPending {
  code?: string;
  wabaId?: string;
  phoneNumberId?: string;
  signupEvent?: "FINISH" | "FINISH_ONLY_WABA";
  /** The session event for this attempt has arrived. */
  sessionDone?: boolean;
  /** Completion fired; nothing else completes until the next launch. */
  submitted?: boolean;
  /** A specific issue was shown; the popup closing must not replace it with "cancelled". */
  reported?: boolean;
}

export type SignupInput =
  | { type: "launch" }
  | { type: "code"; code: string | null }
  | { type: "session"; event: SignupSessionEvent }
  /** The code arrived but no session event followed within the grace period. */
  | { type: "session_timeout" };

export interface SignupStepResult {
  pending: SignupPending;
  complete: EmbeddedSignupPayload | null;
  /** undefined = leave the shown issue as it is; null = clear it. */
  issue?: SignupIssue | null;
  /** The code is in and the session event is still awaited (start the grace timer). */
  waitForSession?: boolean;
}

const DIGITS = /^\d{1,32}$/;
const digits = (v: string | null | undefined) => (v && DIGITS.test(v) ? v : undefined);

function tryComplete(p: SignupPending): SignupStepResult {
  if (p.submitted || !p.code || !p.sessionDone) return { pending: p, complete: null };
  const done = { ...p, submitted: true };
  const payload: EmbeddedSignupPayload = { code: p.code };
  if (p.wabaId) payload.wabaId = p.wabaId;
  if (p.phoneNumberId) payload.phoneNumberId = p.phoneNumberId;
  if (p.signupEvent) payload.signupEvent = p.signupEvent;
  return { pending: done, complete: payload };
}

export function signupStep(prev: SignupPending, input: SignupInput): SignupStepResult {
  if (input.type === "launch") return { pending: {}, complete: null, issue: null };
  if (prev.submitted) return { pending: prev, complete: null };

  if (input.type === "code") {
    if (!input.code) {
      return { pending: prev, complete: null, issue: prev.reported ? undefined : { kind: "cancelled", step: null } };
    }
    const r = tryComplete({ ...prev, code: input.code });
    return r.complete ? r : { ...r, waitForSession: !prev.sessionDone };
  }

  if (input.type === "session_timeout") {
    if (!prev.code || prev.sessionDone) return { pending: prev, complete: null };
    return { pending: { ...prev, submitted: true }, complete: { code: prev.code } };
  }

  const ev = input.event;
  switch (ev.kind) {
    case "finished": {
      // Always sync the number to THIS event: a retry's FINISH without a
      // number must not keep a previous attempt's number with the new WABA.
      const next: SignupPending = {
        ...prev,
        wabaId: digits(ev.wabaId),
        phoneNumberId: digits(ev.phoneNumberId),
        signupEvent: "FINISH",
        sessionDone: true,
        reported: false,
      };
      return { ...tryComplete(next), issue: null };
    }
    case "no_phone_number": {
      const waba = digits(ev.wabaId);
      if (!waba) return { pending: { reported: true }, complete: null, issue: { kind: "no_phone_number" } };
      const next: SignupPending = {
        ...prev,
        wabaId: waba,
        phoneNumberId: undefined,
        signupEvent: "FINISH_ONLY_WABA",
        sessionDone: true,
        reported: false,
      };
      return { ...tryComplete(next), issue: null };
    }
    case "cancelled":
      if (prev.reported) return { pending: prev, complete: null };
      return { pending: {}, complete: null, issue: { kind: "cancelled", step: ev.step } };
    case "error":
      return {
        pending: { reported: true },
        complete: null,
        issue: { kind: "error", errorCode: ev.errorCode, sessionId: ev.sessionId, message: ev.message },
      };
    default:
      return { pending: prev, complete: null };
  }
}
