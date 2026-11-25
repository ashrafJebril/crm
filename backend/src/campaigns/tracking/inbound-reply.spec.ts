import { metaReplyParts, zernioReplyParts } from "./inbound-reply";

describe("button replies store payload and text", () => {
  it("Meta text, button and interactive replies", () => {
    expect(metaReplyParts({ type: "text", text: { body: "Yes please" } })).toEqual({ text: "Yes please", buttonPayload: null });
    expect(metaReplyParts({ type: "button", button: { text: "Stop promotions", payload: "STOP" } })).toEqual({
      text: "Stop promotions",
      buttonPayload: "STOP",
    });
    expect(
      metaReplyParts({ type: "interactive", interactive: { type: "button_reply", button_reply: { id: "btn_yes", title: "Yes" } } }),
    ).toEqual({ text: "Yes", buttonPayload: "btn_yes" });
    expect(
      metaReplyParts({ type: "interactive", interactive: { type: "list_reply", list_reply: { id: "row_2", title: "Branch 2" } } }),
    ).toEqual({ text: "Branch 2", buttonPayload: "row_2" });
    expect(metaReplyParts({ type: "image", image: { id: "m", caption: "pic" } })).toEqual({ text: "pic", buttonPayload: null });
    expect(metaReplyParts({ type: "sticker" })).toEqual({ text: "", buttonPayload: null });
  });

  it("Zernio reads metadata.buttonPayload ?? postbackPayload when present, else null", () => {
    expect(zernioReplyParts({ message: { text: "Yes", metadata: { buttonPayload: "YES" } } })).toEqual({ text: "Yes", buttonPayload: "YES" });
    expect(zernioReplyParts({ message: { text: "Yes", metadata: { postbackPayload: "PB" } } })).toEqual({ text: "Yes", buttonPayload: "PB" });
    expect(zernioReplyParts({ message: { text: "hello" } })).toEqual({ text: "hello", buttonPayload: null });
    expect(zernioReplyParts({ message: { text: null, metadata: { buttonPayload: 5 as unknown as string } } })).toEqual({
      text: "",
      buttonPayload: null,
    });
  });
});
