import { ApiError } from "@/api/client";
import type { Tx } from "@/lib/tx";

/**
 * SP-13 "WhatsApp isn't connected" gating (ruling 6). Every marketing action
 * that reaches WhatsApp answers 409 `campaigns.whatsapp_not_connected` with
 * `code: "WHATSAPP_NOT_CONNECTED"`; reads, drafts and the preview report
 * `connected: false` instead. One bilingual sentence covers the banner and
 * the disabled actions' title. Pure copy, unit-tested.
 */

export const WHATSAPP_NOT_CONNECTED_KEY = "campaigns.whatsapp_not_connected";
export const WHATSAPP_NOT_CONNECTED_CODE = "WHATSAPP_NOT_CONNECTED";

export const GATE_EN = "WhatsApp isn't connected. Connect a number in Channels to send campaigns and submit templates.";
export const GATE_AR = "واتساب غير متصل. اربط رقمًا من القنوات لإرسال الحملات وإرسال القوالب للاعتماد.";

/** The banner sentence, also the `title` of every action it disables. */
export const whatsAppGateText = (tx: Tx): string => tx(GATE_EN, GATE_AR);

export const channelsLinkText = (tx: Tx): string => tx("Open Channels", "افتح القنوات");

/** Actions that reach WhatsApp, so the gate disables them. */
export const MARKETING_ACTIONS = [
  "campaign.launch",
  "campaign.schedule",
  "template.create",
  "template.update",
  "template.library_import",
] as const;
export type MarketingAction = (typeof MARKETING_ACTIONS)[number];

/** The disabled action's title: the gate sentence, or null when connected or unknown. */
export function gatedTitle(_action: MarketingAction, connected: boolean | null, tx: Tx): string | null {
  return connected === false ? whatsAppGateText(tx) : null;
}

/** The 409 any marketing action returns while not connected. */
export function isWhatsAppNotConnected(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  if (err.code === WHATSAPP_NOT_CONNECTED_CODE) return true;
  return err.status === 409 && err.message === WHATSAPP_NOT_CONNECTED_KEY;
}
