import { describe, expect, it } from "vitest";
import { parseEmbeddedSignupMessage, popupAvailable, type MetaConfig } from "./metaConnectLogic";

const FB = "https://www.facebook.com";

describe("parseEmbeddedSignupMessage", () => {
  it("reads phone + WABA ids from a FINISH event (string or object payload)", () => {
    const payload = { type: "WA_EMBEDDED_SIGNUP", event: "FINISH", data: { phone_number_id: "PH", waba_id: "WB" } };
    expect(parseEmbeddedSignupMessage(FB, JSON.stringify(payload))).toEqual({ kind: "finish", phoneNumberId: "PH", wabaId: "WB" });
    expect(parseEmbeddedSignupMessage("https://web.facebook.com", payload)).toEqual({ kind: "finish", phoneNumberId: "PH", wabaId: "WB" });
  });

  it("ignores other origins and non-signup messages", () => {
    const payload = { type: "WA_EMBEDDED_SIGNUP", event: "FINISH", data: { waba_id: "WB" } };
    expect(parseEmbeddedSignupMessage("https://evil.example", payload)).toBeNull();
    expect(parseEmbeddedSignupMessage(FB, { type: "OTHER" })).toBeNull();
    expect(parseEmbeddedSignupMessage(FB, "not json")).toBeNull();
  });

  it("reports cancel and error events", () => {
    expect(parseEmbeddedSignupMessage(FB, { type: "WA_EMBEDDED_SIGNUP", event: "CANCEL", data: { current_step: "PHONE" } })).toEqual({ kind: "cancel", step: "PHONE" });
    expect(parseEmbeddedSignupMessage(FB, { type: "WA_EMBEDDED_SIGNUP", event: "ERROR", data: { error_message: "boom" } })).toEqual({ kind: "error", message: "boom" });
  });
});

describe("popupAvailable", () => {
  const base: MetaConfig = {
    enabled: true,
    appId: "APP",
    waConfigId: "WA",
    fbConfigId: "FB",
    zernio: { whatsapp: false, facebook: false, instagram: false },
  };

  it("is hidden while the switch is off", () => {
    expect(popupAvailable({ ...base, enabled: false }, "whatsapp")).toBe(false);
    expect(popupAvailable(null, "facebook")).toBe(false);
  });

  it("is hidden for platforms connected through Zernio", () => {
    expect(popupAvailable({ ...base, zernio: { whatsapp: true, facebook: false, instagram: false } }, "whatsapp")).toBe(false);
    expect(popupAvailable({ ...base, zernio: { whatsapp: false, facebook: true, instagram: false } }, "instagram")).toBe(false);
  });

  it("needs the matching login configuration", () => {
    expect(popupAvailable({ ...base, waConfigId: null }, "whatsapp")).toBe(false);
    expect(popupAvailable({ ...base, fbConfigId: null }, "facebook")).toBe(false);
    expect(popupAvailable(base, "whatsapp")).toBe(true);
    expect(popupAvailable(base, "facebook")).toBe(true);
  });
});
