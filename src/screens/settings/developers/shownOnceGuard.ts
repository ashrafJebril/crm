/**
 * SP-27 review M1: a secret shown once (API key, webhook signing secret)
 * must not vanish on a stray Escape or backdrop click. Until it has been
 * copied, those close nothing, and an explicit close (Done, Cancel) asks
 * first. After a copy, or when no secret is on screen, everything closes.
 */
export type CloseVia = "escape" | "backdrop" | "button";
export type CloseDecision = "close" | "ignore" | "confirm";

export const SHOWN_ONCE_CLOSE_CONFIRM: [en: string, ar: string] = [
  "You won't see this again. Close anyway?",
  "لن تتمكن من رؤيته مرة أخرى. هل تريد الإغلاق؟",
];

export function closeDecision(o: { secretShown: boolean; copied: boolean; via: CloseVia }): CloseDecision {
  if (!o.secretShown || o.copied) return "close";
  return o.via === "button" ? "confirm" : "ignore";
}

/** Whether the shared Modal may close itself (Escape, backdrop) right now. */
export const modalDismissible = (o: { secretShown: boolean; copied: boolean }) => closeDecision({ ...o, via: "escape" }) === "close";

/** Runs `close` when allowed; asks first when the secret wasn't copied yet. */
export function guardedClose(
  o: { secretShown: boolean; copied: boolean },
  close: () => void,
  confirm: (message: string) => boolean,
  message: string,
): void {
  const d = closeDecision({ ...o, via: "button" });
  if (d === "close" || (d === "confirm" && confirm(message))) close();
}
