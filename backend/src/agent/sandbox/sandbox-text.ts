/** SP-20 sandbox: English operator text for the reply gate's reasons (sent to the model, never shown as UI copy). */
export const GATE_REASON_TEXT: Record<string, string> = {
  stopped: "the agent is stopped",
  conversation_off: "automatic replies are off for this conversation",
  paused: "a team member has taken this conversation over",
  excluded: "this customer is excluded from automatic replies",
  outside_hours: "it is outside the agent's working hours",
  within_hours: "the agent only answers outside working hours",
  unknown: "the reply check failed",
};

/** The fixed owner-facing reply when the model declines (stop_reason refusal). */
export const PREVIEW_REFUSAL_REPLY = "The preview could not answer this / لم تتمكن المعاينة من الإجابة على هذا";

/** The fixed owner-facing reply when the model ends its turn with no text. */
export const PREVIEW_EMPTY_REPLY = "No reply / لا يوجد رد";
