import { phoneFromParticipantId } from "./zernio.service";

/**
 * WhatsApp contacts showed no phone number even though their participant id
 * IS the phone (2026-08-19). Ingestion now derives Contact.phone from it —
 * these pin the normalization rules.
 */
describe("phoneFromParticipantId", () => {
  it("formats a WhatsApp participant id as +E.164", () => {
    expect(phoneFromParticipantId("whatsapp", "962796261184")).toBe("+962796261184");
  });

  it("tolerates an already-prefixed '+'", () => {
    expect(phoneFromParticipantId("whatsapp", "+962796261184")).toBe("+962796261184");
  });

  it("returns null for other channels (opaque user ids, not phones)", () => {
    expect(phoneFromParticipantId("instagram", "17841430008933062")).toBeNull();
    expect(phoneFromParticipantId("facebook", "1058724220665775")).toBeNull();
  });

  it("returns null for malformed ids", () => {
    expect(phoneFromParticipantId("whatsapp", "not-a-number")).toBeNull();
    expect(phoneFromParticipantId("whatsapp", "123")).toBeNull();
    expect(phoneFromParticipantId("whatsapp", "1234567890123456")).toBeNull();
  });
});
