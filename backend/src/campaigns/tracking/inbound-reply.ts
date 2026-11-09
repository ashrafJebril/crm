/**
 * SP-12: the text and tapped-button payload of an inbound reply, per provider
 * (ruling 7).
 *
 * - Meta `button` (template quick reply): payload `button.payload`, text `button.text`.
 * - Meta `interactive`: `button_reply.id` / `list_reply.id`, text from the `title`.
 * - Zernio: `message.metadata.buttonPayload ?? postbackPayload` only when the
 *   webhook carries it (not documented for WhatsApp yet), else null.
 */

export interface ReplyParts {
  text: string;
  buttonPayload: string | null;
}

/** The subset of a Meta WhatsApp inbound message these helpers read. */
export interface MetaInboundMessage {
  type: string;
  text?: { body?: string };
  image?: { id?: string; caption?: string };
  document?: { id?: string; filename?: string };
  button?: { text?: string; payload?: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string; description?: string };
  };
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

export function metaReplyParts(msg: MetaInboundMessage): ReplyParts {
  switch (msg.type) {
    case "text":
      return { text: msg.text?.body ?? "", buttonPayload: null };
    case "image":
      return { text: msg.image?.caption ?? "", buttonPayload: null };
    case "document":
      return { text: msg.document?.filename ?? "", buttonPayload: null };
    case "button":
      return { text: msg.button?.text ?? "", buttonPayload: str(msg.button?.payload) };
    case "interactive": {
      const reply = msg.interactive?.button_reply ?? msg.interactive?.list_reply;
      return { text: reply?.title ?? "", buttonPayload: str(reply?.id) };
    }
    default:
      return { text: "", buttonPayload: null };
  }
}

export interface ZernioInboundLike {
  message?: {
    text?: string | null;
    metadata?: { buttonPayload?: unknown; postbackPayload?: unknown } | null;
  };
}

export function zernioReplyParts(evt: ZernioInboundLike): ReplyParts {
  const meta = evt.message?.metadata ?? null;
  return {
    text: evt.message?.text ?? "",
    buttonPayload: str(meta?.buttonPayload) ?? str(meta?.postbackPayload),
  };
}
