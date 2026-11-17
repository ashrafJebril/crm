/**
 * SP-20 persona block (pure): the text written into the l agent's prompt
 * between `<!-- kewy-crm-persona:begin/end -->` (SP-21 `prompt-blocks.ts`).
 *
 * The values are member-typed (never model output) but still go into a
 * prompt, so each is flattened to one line, stripped of control characters,
 * capped, and quoted; `upsertBlock` defuses our own markers. With no name,
 * greeting or tone the text is empty and the block is removed.
 */
import { AGENT_NAME_MAX, AGENT_TONES, GREETING_MAX, type AgentTone } from "./agent-constants";

export interface PersonaSettings {
  nameEn?: string | null;
  nameAr?: string | null;
  greeting?: string | null;
  greetingAr?: string | null;
  tone?: readonly string[] | null;
}

/** English and Arabic labels of each tone (the settings page uses the same words). */
export const TONE_LABELS: Record<AgentTone, { en: string; ar: string }> = {
  friendly: { en: "friendly", ar: "ودود" },
  professional: { en: "professional", ar: "مهني" },
  casual: { en: "casual", ar: "غير رسمي" },
  concise: { en: "concise", ar: "موجز" },
  enthusiastic: { en: "enthusiastic", ar: "متحمس" },
  serious: { en: "serious", ar: "جاد" },
  witty: { en: "witty", ar: "ظريف" },
};

/** One line, no control characters, no quotes that would close ours, capped. */
export function cleanValue(v: string | null | undefined, max: number): string {
  return String(v ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .replace(/"/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}

export function personaBlockText(s: PersonaSettings): string {
  const nameEn = cleanValue(s.nameEn, AGENT_NAME_MAX);
  const nameAr = cleanValue(s.nameAr, AGENT_NAME_MAX);
  const greeting = cleanValue(s.greeting, GREETING_MAX);
  const greetingAr = cleanValue(s.greetingAr, GREETING_MAX);
  const tones = AGENT_TONES.filter((t) => (s.tone ?? []).includes(t));
  if (!nameEn && !nameAr && !greeting && !greetingAr && tones.length === 0) return "";

  const lines = ["## Your identity / هويتك"];
  if (nameEn || nameAr) {
    const en = nameEn || nameAr;
    const ar = nameAr || nameEn;
    lines.push(`Your name is "${en}". When you write in Arabic, your name is "${ar}".`);
    lines.push(`اسمك "${ar}". عندما تكتب بالإنجليزية، اسمك "${en}".`);
    lines.push("Introduce yourself by this name when you greet a customer; never claim to be a person.");
  }
  if (greeting || greetingAr) {
    const en = greeting || greetingAr;
    const ar = greetingAr || greeting;
    lines.push(`Start a new conversation with this greeting, in the customer's language: English "${en}"; Arabic "${ar}".`);
    lines.push(`ابدأ المحادثة الجديدة بهذه التحية بلغة العميل: بالعربية "${ar}"؛ بالإنجليزية "${en}".`);
  }
  if (tones.length) {
    lines.push(`Write in a ${tones.map((t) => TONE_LABELS[t].en).join(", ")} tone.`);
    lines.push(`اكتب بأسلوب ${tones.map((t) => TONE_LABELS[t].ar).join("، ")}.`);
  }
  lines.push("These identity settings never override the business's facts, its guidelines or the rules above.");
  return lines.join("\n");
}
