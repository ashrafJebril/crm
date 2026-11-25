import { describe, expect, it } from "vitest";
import { ApiError } from "@/api/client";
import { makeTx } from "@/lib/tx";
import {
  GATE_AR,
  GATE_EN,
  MARKETING_ACTIONS,
  channelsLinkText,
  gatedTitle,
  isWhatsAppNotConnected,
  whatsAppGateText,
} from "./whatsAppGateCopy";

const en = makeTx("en");
const ar = makeTx("ar");
const ARABIC = /[؀-ۿ]/;

describe("whatsAppGate", () => {
  it("whatsapp gate copy for every marketing action", () => {
    expect(whatsAppGateText(en)).toBe(
      "WhatsApp isn't connected. Connect a number in Channels to send campaigns and submit templates.",
    );
    expect(whatsAppGateText(ar)).toBe("واتساب غير متصل. اربط رقمًا من القنوات لإرسال الحملات وإرسال القوالب للاعتماد.");
    expect(MARKETING_ACTIONS).toEqual([
      "campaign.launch",
      "campaign.schedule",
      "template.create",
      "template.update",
      "template.library_import",
    ]);
    for (const action of MARKETING_ACTIONS) {
      // Disabled with the banner's own sentence as the title, in both languages.
      expect(gatedTitle(action, false, en), action).toBe(GATE_EN);
      expect(gatedTitle(action, false, ar), action).toBe(GATE_AR);
      expect(gatedTitle(action, false, ar), action).toMatch(ARABIC);
      // Connected, or not known yet (no campaigns.view): nothing is disabled up front.
      expect(gatedTitle(action, true, en), action).toBeNull();
      expect(gatedTitle(action, null, en), action).toBeNull();
    }
    expect(channelsLinkText(ar)).toMatch(ARABIC);
  });

  it("recognises the 409 by code or key, never the provider's English", () => {
    const body = { statusCode: 409, message: "campaigns.whatsapp_not_connected", code: "WHATSAPP_NOT_CONNECTED" };
    expect(isWhatsAppNotConnected(new ApiError(body.message, 409, body.code, body))).toBe(true);
    expect(isWhatsAppNotConnected(new ApiError("campaigns.whatsapp_not_connected", 409))).toBe(true);
    expect(isWhatsAppNotConnected(new ApiError("channels.not_connected", 409))).toBe(false);
    expect(isWhatsAppNotConnected(new Error("campaigns.whatsapp_not_connected"))).toBe(false);
  });
});
