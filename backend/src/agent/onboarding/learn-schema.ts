/**
 * SP-20 "What I learned" card: the structured-output JSON schema sent to
 * Claude, the zod schema the reply is validated with, and the cleaning that
 * caps and trims what the model wrote (model output is untrusted).
 *
 * The JSON schema uses only what strict structured outputs accept (no
 * length or count limits); the caps are applied here after parsing:
 * FAQs ≤ LEARN_FAQS_MAX, services ≤ LEARN_SERVICES_MAX, question ≤ 300,
 * answer ≤ 2 000, description ≤ 4 000, names ≤ 120. Control characters and
 * script-like URL schemes are removed from every string; an hours schedule
 * that SP-10's validator refuses is dropped.
 */
import { z } from "zod";
import { validateSchedule, type WeeklySchedule } from "../../bookings/schedule";
import { WEEKDAYS } from "../../bookings/booking-time";
import { SERVICE_DURATION_MAX } from "../../bookings/booking-constants";
import { BUSINESS_NAME_MAX, LEARN_FAQS_MAX, LEARN_SERVICES_MAX } from "../agent-constants";

export const LEARN_QUESTION_MAX = 300;
export const LEARN_ANSWER_MAX = 2000;
export const LEARN_DESCRIPTION_MAX = 4000;
export const LEARN_SERVICE_NAME_MAX = 120;

export interface LearnFaq {
  question: string;
  answer: string;
}
export interface LearnService {
  name: string;
  nameAr?: string;
  price?: number;
  currency?: string;
  durationMin?: number;
}
export interface LearnCard {
  business: { name: string; descriptionEn?: string; descriptionAr?: string };
  faqs: LearnFaq[];
  services: LearnService[];
  hours?: WeeklySchedule;
  sourcePages: string[];
}

const str = { type: "string" } as const;
const window = { type: "object", additionalProperties: false, required: ["from", "to"], properties: { from: str, to: str } } as const;

/** Strict structured-output schema (`output_config.format`). */
export const LEARN_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["business", "faqs", "services"],
  properties: {
    business: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: {
        name: { type: "string", description: "The business's name as the website states it." },
        descriptionEn: { type: "string", description: "What the business does, in English, from the website text only." },
        descriptionAr: { type: "string", description: "The same description in Arabic." },
      },
    },
    faqs: {
      type: "array",
      description: `Up to ${LEARN_FAQS_MAX} questions customers would ask, answered only from the website text.`,
      items: { type: "object", additionalProperties: false, required: ["question", "answer"], properties: { question: str, answer: str } },
    },
    services: {
      type: "array",
      description: `Up to ${LEARN_SERVICES_MAX} services or products the website lists, with price and duration only when stated.`,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: {
          name: str,
          nameAr: str,
          price: { type: "number" },
          currency: { type: "string", description: "ISO 4217 code, e.g. SAR" },
          durationMin: { type: "integer" },
        },
      },
    },
    hours: {
      type: "object",
      description: "Weekly opening hours only when the website states them; times as HH:MM, 24-hour.",
      additionalProperties: false,
      properties: Object.fromEntries(WEEKDAYS.map((d) => [d, { type: "array", items: window }])),
    },
  },
} as const;

const zWindow = z.object({ from: z.string(), to: z.string() });
/** Types are enforced; lengths and counts are capped by `cleanLearnReply`. Unknown keys are dropped. */
export const LearnReplySchema = z.object({
  business: z.object({
    name: z.string(),
    descriptionEn: z.string().optional().nullable(),
    descriptionAr: z.string().optional().nullable(),
  }),
  faqs: z.array(z.object({ question: z.string(), answer: z.string() })),
  services: z.array(
    z.object({
      name: z.string(),
      nameAr: z.string().optional().nullable(),
      price: z.number().optional().nullable(),
      currency: z.string().optional().nullable(),
      durationMin: z.number().optional().nullable(),
    }),
  ),
  hours: z.record(z.array(zWindow)).optional().nullable(),
});
export type LearnReply = z.infer<typeof LearnReplySchema>;

/** One line or paragraph text: no control characters, no script-like URL schemes, trimmed, capped. */
export function cleanText(v: unknown, max: number, multiline = false): string {
  let s = String(v ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(multiline ? /[\u0000-\u0009\u000b-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g, " ")
    .replace(/\b(?:javascript|vbscript|data|file)\s*:/gi, "");
  s = multiline ? s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n") : s.replace(/\s+/g, " ");
  return s.trim().slice(0, max).trim();
}

function cleanHours(h: LearnReply["hours"]): WeeklySchedule | undefined {
  if (!h) return undefined;
  try {
    const s = validateSchedule(h);
    return Object.keys(s).length ? s : undefined;
  } catch {
    return undefined; // e.g. "25:00": dropped, never guessed
  }
}

export function cleanLearnReply(reply: LearnReply, sourcePages: string[]): LearnCard {
  const faqs: LearnFaq[] = [];
  const seen = new Set<string>();
  for (const f of reply.faqs) {
    const question = cleanText(f.question, LEARN_QUESTION_MAX);
    const answer = cleanText(f.answer, LEARN_ANSWER_MAX, true);
    const key = question.toLowerCase();
    if (!question || !answer || seen.has(key)) continue;
    seen.add(key);
    faqs.push({ question, answer });
    if (faqs.length >= LEARN_FAQS_MAX) break;
  }
  const services: LearnService[] = [];
  for (const s of reply.services) {
    const name = cleanText(s.name, LEARN_SERVICE_NAME_MAX);
    if (!name) continue;
    const out: LearnService = { name };
    const nameAr = cleanText(s.nameAr, LEARN_SERVICE_NAME_MAX);
    if (nameAr) out.nameAr = nameAr;
    if (typeof s.price === "number" && Number.isFinite(s.price) && s.price >= 0) out.price = Math.round(s.price * 100) / 100;
    const currency = cleanText(s.currency, 3).toUpperCase();
    if (/^[A-Z]{3}$/.test(currency)) out.currency = currency;
    if (typeof s.durationMin === "number" && Number.isInteger(s.durationMin) && s.durationMin >= 5 && s.durationMin <= SERVICE_DURATION_MAX) {
      out.durationMin = s.durationMin;
    }
    services.push(out);
    if (services.length >= LEARN_SERVICES_MAX) break;
  }
  const descriptionEn = cleanText(reply.business.descriptionEn, LEARN_DESCRIPTION_MAX, true);
  const descriptionAr = cleanText(reply.business.descriptionAr, LEARN_DESCRIPTION_MAX, true);
  const hours = cleanHours(reply.hours);
  return {
    business: {
      name: cleanText(reply.business.name, BUSINESS_NAME_MAX),
      ...(descriptionEn ? { descriptionEn } : {}),
      ...(descriptionAr ? { descriptionAr } : {}),
    },
    faqs,
    services,
    ...(hours ? { hours } : {}),
    sourcePages,
  };
}
