/**
 * SP-22 (Review Focus 4): the l answer is untrusted output. Before a
 * Telegram or web-chat auto-reply is sent it must be a non-empty string of at
 * most AGENT_ANSWER_MAX characters after trimming (longer answers are cut at
 * a sentence boundary and end with "…"), with control characters removed
 * (newlines and tabs kept). The image URL is only passed on here; the
 * caller checks it against the workspace's approved media (SP-17).
 */
export const AGENT_ANSWER_MAX = 4_000;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g;

function cutAtSentence(text: string, max: number): string {
  const room = max - 1; // for the ellipsis
  const head = text.slice(0, room);
  // The last sentence end (., !, ?, ؟, newline) in the second half of the room.
  let cut = -1;
  for (const m of head.matchAll(/[.!?؟。](\s|$)|\n/g)) cut = (m.index ?? -1) + 1;
  if (cut < room / 2) {
    const space = head.lastIndexOf(" ");
    cut = space > room / 2 ? space : room;
  }
  return `${head.slice(0, cut).trimEnd()}…`;
}

export function validateAgentAnswer(input: { answer: unknown; image_url?: unknown }): { text: string; imageUrl?: string } | null {
  if (typeof input.answer !== "string") return null;
  let text = input.answer.replace(/\r\n?/g, "\n").replace(CONTROL, "").trim();
  if (!text) return null;
  if (text.length > AGENT_ANSWER_MAX) text = cutAtSentence(text, AGENT_ANSWER_MAX);
  const imageUrl = typeof input.image_url === "string" && /^https:\/\//i.test(input.image_url.trim()) ? input.image_url.trim() : undefined;
  return imageUrl ? { text, imageUrl } : { text };
}
