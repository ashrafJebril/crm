import { describe, expect, it } from "vitest";
import {
  embeddedSignupExtras,
  isFacebookOrigin,
  metaErrorReference,
  readSignupSessionEvent,
  signupStep,
  type SignupPending,
} from "./embeddedSignupSession";

const msg = (event: string, data: Record<string, unknown> = {}) => ({ type: "WA_EMBEDDED_SIGNUP", event, data });

describe("readSignupSessionEvent", () => {
  it("ignores non-signup payloads", () => {
    expect(readSignupSessionEvent(null)).toBeNull();
    expect(readSignupSessionEvent("x")).toBeNull();
    expect(readSignupSessionEvent({ type: "OTHER" })).toBeNull();
  });
  it("reads FINISH with waba and number", () => {
    expect(readSignupSessionEvent(msg("FINISH", { waba_id: "111", phone_number_id: "222" }))).toEqual({
      kind: "finished",
      event: "FINISH",
      wabaId: "111",
      phoneNumberId: "222",
    });
  });
  it("reads FINISH_ONLY_WABA as no_phone_number", () => {
    expect(readSignupSessionEvent(msg("FINISH_ONLY_WABA", { waba_id: 111 }))).toEqual({
      kind: "no_phone_number",
      event: "FINISH_ONLY_WABA",
      wabaId: "111",
    });
  });
  it("reads CANCEL with a step", () => {
    expect(readSignupSessionEvent(msg("CANCEL", { current_step: "PHONE_NUMBER_SETUP" }))).toEqual({
      kind: "cancelled",
      step: "PHONE_NUMBER_SETUP",
    });
  });
  it("reads ERROR, and CANCEL carrying error_message, as error", () => {
    const e = { kind: "error", errorCode: "4563039", sessionId: "s-1", message: "Boom" };
    expect(readSignupSessionEvent(msg("ERROR", { error_code: 4563039, session_id: "s-1", error_message: "Boom" }))).toEqual(e);
    expect(readSignupSessionEvent(msg("CANCEL", { error_code: "4563039", session_id: "s-1", error_message: "Boom" }))).toEqual(e);
  });
  it("keeps unknown events visible", () => {
    expect(readSignupSessionEvent(msg("SOMETHING_NEW"))).toEqual({ kind: "unknown", event: "SOMETHING_NEW" });
  });
});

describe("metaErrorReference", () => {
  it("formats Meta's support reference", () => {
    expect(metaErrorReference({ errorCode: "1", sessionId: "s" })).toBe("#1:s");
    expect(metaErrorReference({ errorCode: null, sessionId: "s" })).toBe("#N/A:s");
    expect(metaErrorReference({ errorCode: null, sessionId: null })).toBeNull();
  });
});

describe("embeddedSignupExtras", () => {
  it("omits coexistence (R6) and adds the solution id only when set", () => {
    expect(embeddedSignupExtras("")).toEqual({ setup: {} });
    expect(embeddedSignupExtras("sol")).toEqual({ setup: { solutionID: "sol" } });
  });
});

describe("isFacebookOrigin", () => {
  it("accepts facebook.com and its subdomains only", () => {
    expect(isFacebookOrigin("https://www.facebook.com")).toBe(true);
    expect(isFacebookOrigin("https://web.facebook.com")).toBe(true);
    expect(isFacebookOrigin("https://facebook.com")).toBe(true);
    expect(isFacebookOrigin("https://facebook.com.evil.io")).toBe(false);
    expect(isFacebookOrigin("https://evilfacebook.com")).toBe(false);
    expect(isFacebookOrigin("null")).toBe(false);
  });
});

describe("signupStep (code and session event join)", () => {
  const launched = signupStep({}, { type: "launch" }).pending;
  const finish = { type: "session" as const, event: readSignupSessionEvent(msg("FINISH", { waba_id: "111", phone_number_id: "222" }))! };
  const code = { type: "code" as const, code: "CODE" };

  it("finished: session first, code last completes once", () => {
    let p: SignupPending = launched;
    const a = signupStep(p, finish);
    expect(a.complete).toBeNull();
    p = a.pending;
    const b = signupStep(p, code);
    expect(b.complete).toEqual({ code: "CODE", wabaId: "111", phoneNumberId: "222", signupEvent: "FINISH" });
    // A duplicate event after completion does nothing.
    expect(signupStep(b.pending, finish).complete).toBeNull();
    expect(signupStep(b.pending, code).complete).toBeNull();
  });

  it("finished: code first, session last completes", () => {
    const a = signupStep(launched, code);
    expect(a.complete).toBeNull();
    expect(a.waitForSession).toBe(true);
    const b = signupStep(a.pending, finish);
    expect(b.complete).toEqual({ code: "CODE", wabaId: "111", phoneNumberId: "222", signupEvent: "FINISH" });
  });

  it("only-WABA finish completes as FINISH_ONLY_WABA without a number", () => {
    const only = { type: "session" as const, event: readSignupSessionEvent(msg("FINISH_ONLY_WABA", { waba_id: "111" }))! };
    const b = signupStep(signupStep(launched, only).pending, code);
    expect(b.complete).toEqual({ code: "CODE", wabaId: "111", signupEvent: "FINISH_ONLY_WABA" });
  });

  it("only-WABA without a WABA id is an issue", () => {
    const bare = { type: "session" as const, event: readSignupSessionEvent(msg("FINISH_ONLY_WABA"))! };
    const a = signupStep(launched, bare);
    expect(a.issue).toEqual({ kind: "no_phone_number" });
    // The dialog closing afterwards does not replace the reported issue.
    const b = signupStep(a.pending, { type: "code", code: null });
    expect(b.issue).toBeUndefined();
  });

  it("cancelled: CANCEL then the dialog closes without a code", () => {
    const cancel = { type: "session" as const, event: readSignupSessionEvent(msg("CANCEL", { current_step: "X" }))! };
    const a = signupStep(launched, cancel);
    expect(a.issue).toEqual({ kind: "cancelled", step: "X" });
    expect(a.complete).toBeNull();
  });

  it("dialog closed without code and no event is cancelled", () => {
    expect(signupStep(launched, { type: "code", code: null }).issue).toEqual({ kind: "cancelled", step: null });
  });

  it("error is reported and a later CANCEL does not overwrite it", () => {
    const err = { type: "session" as const, event: readSignupSessionEvent(msg("ERROR", { error_code: "9", session_id: "s" }))! };
    const a = signupStep(launched, err);
    expect(a.issue).toEqual({ kind: "error", errorCode: "9", sessionId: "s", message: null });
    const cancel = { type: "session" as const, event: readSignupSessionEvent(msg("CANCEL"))! };
    expect(signupStep(a.pending, cancel).issue).toBeUndefined();
  });

  it("a FINISH after an error in the same attempt still completes (Meta's Retry)", () => {
    const err = { type: "session" as const, event: readSignupSessionEvent(msg("ERROR", { error_code: "9" }))! };
    const a = signupStep(launched, err);
    const b = signupStep(a.pending, finish);
    expect(b.issue).toBeNull();
    expect(signupStep(b.pending, code).complete?.wabaId).toBe("111");
  });

  it("code arrives but the session event never does: the timeout completes with the code alone", () => {
    const a = signupStep(launched, code);
    const b = signupStep(a.pending, { type: "session_timeout" });
    expect(b.complete).toEqual({ code: "CODE" });
    // A timeout before any code, or after completion, does nothing.
    expect(signupStep(launched, { type: "session_timeout" }).complete).toBeNull();
    expect(signupStep(b.pending, { type: "session_timeout" }).complete).toBeNull();
  });

  it("a relaunch resets the cell so a retry can complete again", () => {
    const done = signupStep(signupStep(launched, finish).pending, code);
    expect(done.complete).not.toBeNull();
    const again = signupStep(done.pending, { type: "launch" });
    expect(again.pending).toEqual({});
    const b = signupStep(signupStep(again.pending, code).pending, finish);
    expect(b.complete).not.toBeNull();
  });

  it("drops ids that are not digits (backend DTO would 400)", () => {
    const bad = { type: "session" as const, event: readSignupSessionEvent(msg("FINISH", { waba_id: "x1", phone_number_id: "22a" }))! };
    const b = signupStep(signupStep(launched, bad).pending, code);
    expect(b.complete).toEqual({ code: "CODE", signupEvent: "FINISH" });
  });

  it("a retry FINISH without a number does not keep the previous attempt's number", () => {
    const noNum = { type: "session" as const, event: readSignupSessionEvent(msg("FINISH", { waba_id: "333" }))! };
    const p = signupStep(launched, finish).pending;
    const b = signupStep(signupStep(p, noNum).pending, code);
    expect(b.complete).toEqual({ code: "CODE", wabaId: "333", signupEvent: "FINISH" });
  });
});
