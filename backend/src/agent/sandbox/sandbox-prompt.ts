/**
 * SP-20 "Try your agent" system prompt (pure).
 *
 *  - Base: the agent's live l prompt when the workspace is linked, else the
 *    CRM sections setup appends (tools, photos, booking slots, knowledge).
 *  - The persona and guidelines blocks are written over the base with SP-21's
 *    `upsertBlock`, so the preview reflects the latest saved settings even
 *    before they are published.
 *  - A fixed preview notice comes last: write tools are simulated and the
 *    person chatting is the owner testing the agent.
 *
 * The system prompt is stable for a thread (the prompt cache and preserved
 * thinking depend on it); per-turn facts (the date and time, the reply gate's
 * decision) go in `turnNote`, sent as a mid-conversation system message.
 */
import { upsertBlock } from "../../knowledge-sources/prompt-blocks";
import { GATE_REASON_TEXT } from "./sandbox-text";

export const PREVIEW_NOTICE = [
  "## Preview mode",
  "You are being tested by the business owner in a private preview chat. Answer exactly as you would answer a customer.",
  "Read tools (appointments, services, free slots, contacts, approved photos and the knowledge base) return real data.",
  'Write tools are simulated: their result says "NOT saved". When that happens, answer as you would to a customer, then add one short line telling the owner what would have been saved.',
  "Never claim that anything was booked, created, changed or sent in this preview.",
].join("\n");

export function composeSandboxSystem(input: { live: string | null; sections: string; persona: string; guidelines: string; guidelinesBlock: string }): string {
  let base = (input.live ?? "").trim() ? (input.live as string) : input.sections;
  base = upsertBlock(base, "persona", input.persona).prompt;
  base = upsertBlock(base, input.guidelinesBlock, input.guidelines).prompt;
  return `${base.trimEnd()}\n\n${PREVIEW_NOTICE}`;
}

/** Local date and time in the workspace timezone, with Latin digits. */
export function localNow(now: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(now);
  } catch {
    return now.toISOString();
  }
}

/** The per-turn operator note (after the owner's message). */
export function turnNote(input: { now: Date; tz: string; gate: { wouldReply: boolean; reason: string } }): string {
  const when = `It is now ${localNow(input.now, input.tz)} (${input.tz}).`;
  const gate = input.gate.wouldReply
    ? "With the current settings, the live agent would answer a real customer now."
    : `With the current settings, the live agent would NOT answer a real customer now (${GATE_REASON_TEXT[input.gate.reason] ?? input.gate.reason}). Answer anyway: this is a preview.`;
  return `${when} ${gate}`;
}
