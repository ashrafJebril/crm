import type { Conversation } from "../../lib/types";

export type SendRoute = "native" | "zernio" | "meta_wa" | "meta_ig" | "legacy";

/**
 * Which transport carries a reply for a DB conversation. The channel's provider
 * (from the list row) decides; the Zernio status guess is only the fallback for
 * rows without one.
 */
export function pickSendRoute(
  conv: Pick<Conversation, "channel" | "channelProvider">,
  zernioOwnsChannel: boolean,
): SendRoute {
  const p = conv.channelProvider;
  if (p === "telegram" || p === "native") return "native";
  if (p === "zernio") return "zernio";
  if (!p && zernioOwnsChannel) return "zernio";
  if (conv.channel === "instagram") return "meta_ig";
  if (conv.channel === "whatsapp") return "meta_wa";
  return "legacy";
}

/** WhatsApp templates only exist on WhatsApp; Telegram and web chat have none. */
export function supportsTemplates(conv: Pick<Conversation, "channel">): boolean {
  return conv.channel === "whatsapp";
}
