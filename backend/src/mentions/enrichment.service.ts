import { Injectable, Logger } from "@nestjs/common";
import Anthropic from "@anthropic-ai/sdk";

export interface Enrichment {
  lang: "en" | "ar" | "mixed";
  dialect: "msa" | "gulf" | "egyptian" | "levantine" | "maghrebi" | null;
  sentiment: number; // -1..+1
  topic: string | null;
}

const SYSTEM_PROMPT = `You classify short social/news snippets about a brand.
Return strict JSON: { "lang": "en" | "ar" | "mixed",
                       "dialect": "msa" | "gulf" | "egyptian" | "levantine" | "maghrebi" | null,
                       "sentiment": number between -1 and 1,
                       "topic": short 2-4 word topic label or null }.
Rules:
- dialect MUST be null when lang is "en" or "mixed".
- dialect MUST NOT be null when lang is "ar".
- sentiment: -1 very negative, 0 neutral, +1 very positive.
- topic: lowercase, no punctuation, e.g. "delivery delay", "product quality".
- Output ONLY the JSON object, no prose.`;

@Injectable()
export class EnrichmentService {
  private readonly logger = new Logger(EnrichmentService.name);
  private readonly client: Anthropic | null;

  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    this.client = apiKey ? new Anthropic({ apiKey }) : null;
    if (!this.client) this.logger.warn("ANTHROPIC_API_KEY not set — enrichment will fall back to neutral defaults");
  }

  async enrich(body: string): Promise<Enrichment> {
    if (!this.client) return { lang: "en", dialect: null, sentiment: 0, topic: null };

    try {
      const resp = await this.client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 400,
        system: [
          {
            type: "text",
            text: SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content: body.slice(0, 2000) }],
      });

      const first = resp.content[0];
      if (!first || first.type !== "text") return this.fallback();
      const parsed = JSON.parse(this.stripFence(first.text)) as Enrichment;
      return this.coerce(parsed);
    } catch (err) {
      this.logger.warn(`Enrichment failed: ${(err as Error).message}`);
      return this.fallback();
    }
  }

  private stripFence(s: string): string {
    return s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  }

  private fallback(): Enrichment {
    return { lang: "en", dialect: null, sentiment: 0, topic: null };
  }

  private coerce(e: Partial<Enrichment>): Enrichment {
    const lang = e.lang === "ar" || e.lang === "mixed" || e.lang === "en" ? e.lang : "en";
    const dialect =
      lang === "en" || lang === "mixed"
        ? null
        : ["msa", "gulf", "egyptian", "levantine", "maghrebi"].includes(e.dialect as string)
          ? (e.dialect as Enrichment["dialect"])
          : "msa";
    const rawSent = typeof e.sentiment === "number" ? e.sentiment : 0;
    const sentiment = Math.max(-1, Math.min(1, rawSent));
    const normalizedTopic =
      typeof e.topic === "string"
        ? e.topic.toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, " ")
        : "";
    const topic = normalizedTopic.length > 0 && normalizedTopic.length < 40 ? normalizedTopic : null;
    return { lang, dialect, sentiment, topic };
  }
}
