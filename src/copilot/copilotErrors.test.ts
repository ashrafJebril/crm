import { describe, expect, it } from "vitest";
import { ApiError } from "@/api/client";
import { makeTx } from "@/lib/tx";
// The backend files are the fixtures (read as text; never compiled here).
import backendErrors from "../../backend/src/copilot/copilot-errors.ts?raw";
import backendActions from "../../backend/src/copilot/copilot-actions.service.ts?raw";
import { COPILOT_ERROR_COPY, copilotErrorText, copilotKeyText } from "./copilotErrors";

const en = makeTx("en");
const ar = makeTx("ar");
const ARABIC = /[؀-ۿ]/;
const ARABIC_DIGITS = /[٠-٩]/;

function httpKeys(): string[] {
  const m = /COPILOT_ERROR_STATUS = \{([\s\S]*?)\}\s*as const/.exec(backendErrors);
  if (!m) throw new Error("COPILOT_ERROR_STATUS not found");
  return [...m[1].matchAll(/"(copilot\.[a-z_]+)"/g)].map((x) => x[1]);
}
function streamCodes(): string[] {
  const m = /STREAM_ERROR_CODES = \[([^\]]*)\]/.exec(backendErrors);
  if (!m) throw new Error("STREAM_ERROR_CODES not found");
  return [...m[1].matchAll(/"(copilot\.[a-z_]+)"/g)].map((x) => x[1]);
}
/** errorKey values the actions service stores on a FAILED card (besides service messages). */
function cardKeys(): string[] {
  return [...new Set([...backendActions.matchAll(/"(copilot\.action_(?:unknown|failed))"/g)].map((x) => x[1]))];
}

describe("copilot error copy covers every SP-18 key in both languages", () => {
  it("the key list matches the backend exactly (plus the client's stream_lost)", () => {
    expect(httpKeys()).toHaveLength(17);
    expect(streamCodes()).toEqual(expect.arrayContaining(["copilot.ai_failed", "copilot.attachment_unavailable"]));
    expect(cardKeys().sort()).toEqual(["copilot.action_failed", "copilot.action_unknown"]);
    expect(Object.keys(COPILOT_ERROR_COPY).sort()).toEqual([...httpKeys(), ...streamCodes(), ...cardKeys(), "copilot.stream_lost"].sort());
  });

  it.each([...httpKeys(), ...streamCodes(), ...cardKeys(), "copilot.stream_lost"])("%s has distinct English and Arabic copy, Latin digits", (key) => {
    const e = copilotKeyText(key, en, { max: 5, maxBytes: 5 * 1024 * 1024, index: 2, retryAfterSeconds: 90, status: "EXECUTED" });
    const a = copilotKeyText(key, ar, { max: 5, maxBytes: 5 * 1024 * 1024, index: 2, retryAfterSeconds: 90, status: "EXECUTED" });
    expect(e).not.toMatch(ARABIC);
    expect(e).not.toMatch(/Something went wrong/);
    expect(a).toMatch(ARABIC);
    expect(a).not.toMatch(ARABIC_DIGITS);
  });

  it("uses the extras and the requested wording", () => {
    expect(copilotKeyText("copilot.attachment_unavailable", en)).toBe("An attached image can't be loaded right now. Try again, or start a new chat.");
    expect(copilotKeyText("copilot.attachment_unavailable", ar)).toBe("تعذّر تحميل صورة مرفقة الآن. حاول مرة أخرى أو ابدأ محادثة جديدة.");
    expect(copilotKeyText("copilot.action_unknown", en)).toBe("Status unknown — check the record.");
    expect(streamCodes()).toContain("copilot.session_expired");
    expect(copilotKeyText("copilot.session_expired", en)).toMatch(/Sign in again/);
    expect(copilotKeyText("copilot.permission_revoked", ar)).toBe("تغيّرت صلاحياتك، لذلك لم يُنفَّذ شيء.");
    expect(copilotKeyText("copilot.ref_not_permitted", en, { index: 1 })).toContain("record 2");
    expect(copilotKeyText("copilot.attachment_too_large", en, { maxBytes: 5 * 1024 * 1024 })).toContain("5 MB");
    expect(copilotKeyText("copilot.daily_limit", en, { retryAfterSeconds: 7200 })).toContain("2 hours");
    expect(copilotKeyText("copilot.action_closed", en, { status: "REJECTED" })).toContain("declined");
    const err = new ApiError("copilot.rate", 429, undefined, { statusCode: 429, message: "copilot.rate", retryAfterSeconds: 120 });
    expect(copilotErrorText(err, en)).toContain("2 minutes");
    expect(copilotErrorText(new ApiError("Forbidden", 403), en)).toMatch(/permission/);
    expect(copilotErrorText(new Error("x"), en)).toMatch(/Something went wrong/);
  });
});
