// Meta Tech Provider popup connect — pure helpers (no React) so they're testable.

export interface MetaConfig {
  enabled: boolean;
  appId?: string | null;
  waConfigId?: string | null;
  fbConfigId?: string | null;
  graphVersion?: string;
  zernio: { whatsapp: boolean; facebook: boolean; instagram: boolean };
}

export type EmbeddedSignupEvent =
  | { kind: "finish"; phoneNumberId?: string; wabaId: string }
  | { kind: "cancel"; step?: string }
  | { kind: "error"; message: string };

const FB_ORIGINS = new Set(["https://www.facebook.com", "https://web.facebook.com"]);

/**
 * Parse a window `message` event from Meta's Embedded Signup popup. Returns
 * null for anything that isn't an Embedded Signup message from facebook.com.
 */
export function parseEmbeddedSignupMessage(origin: string, data: unknown): EmbeddedSignupEvent | null {
  if (!FB_ORIGINS.has(origin)) return null;
  let msg: unknown = data;
  if (typeof data === "string") {
    try {
      msg = JSON.parse(data);
    } catch {
      return null;
    }
  }
  const m = msg as {
    type?: string;
    event?: string;
    data?: { phone_number_id?: string; waba_id?: string; current_step?: string; error_message?: string };
  } | null;
  if (m?.type !== "WA_EMBEDDED_SIGNUP") return null;
  const ev = m.event ?? "";
  if (ev.startsWith("FINISH")) {
    if (!m.data?.waba_id) return { kind: "error", message: "Meta did not return a WhatsApp Business Account" };
    return { kind: "finish", phoneNumberId: m.data.phone_number_id, wabaId: m.data.waba_id };
  }
  if (ev === "CANCEL") return { kind: "cancel", step: m.data?.current_step };
  if (ev === "ERROR") return { kind: "error", message: m.data?.error_message ?? "Embedded Signup failed" };
  return null;
}

/** Whether to offer the popup for a platform in this workspace. */
export function popupAvailable(cfg: MetaConfig | null | undefined, platform: "whatsapp" | "facebook" | "instagram"): boolean {
  if (!cfg?.enabled || !cfg.appId) return false;
  if (cfg.zernio[platform]) return false;
  if (platform === "whatsapp") return !!cfg.waConfigId;
  // Instagram connects through the linked Facebook Page.
  return !!cfg.fbConfigId && !cfg.zernio.facebook;
}
