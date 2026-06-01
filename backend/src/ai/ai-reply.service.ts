import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { OpenAiService } from "../openai/openai.service";
import {
  KnowledgeSearchService,
  KnowledgeSearchHit,
} from "../knowledge/knowledge-search.service";

export interface AiReplyResult {
  action: "reply" | "escalate";
  reply: string | null;
  confidence: number;
  needsEscalation: boolean;
  escalationReason: string | null;
  usedKnowledge: boolean;
  missingInformation: string | null;
}

export interface AiReplyContext {
  workspaceId: string;
  conversationId: string;
  inboundMessageId: string;
  inboundText: string;
  contactName?: string;
}

export interface AiReplyOutcome extends AiReplyResult {
  modelName: string;
  promptTokens?: number;
  completionTokens?: number;
  sources: Array<{ chunkId: string; similarity: number }>;
}

const REPLY_JSON_SCHEMA = {
  name: "tkana_reply",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      action:             { type: "string", enum: ["reply", "escalate"] },
      reply:              { type: ["string", "null"] },
      confidence:         { type: "number" },
      needsEscalation:    { type: "boolean" },
      escalationReason:   { type: ["string", "null"] },
      usedKnowledge:      { type: "boolean" },
      missingInformation: { type: ["string", "null"] },
    },
    required: [
      "action", "reply", "confidence", "needsEscalation",
      "escalationReason", "usedKnowledge", "missingInformation",
    ],
  },
} as const;

@Injectable()
export class AiReplyService {
  private readonly log = new Logger(AiReplyService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly openai: OpenAiService,
    private readonly search: KnowledgeSearchService,
  ) {}

  parseStructuredOutput(raw: string): AiReplyResult {
    const obj = JSON.parse(raw);
    if (obj.action !== "reply" && obj.action !== "escalate") {
      throw new Error(`invalid action: ${obj.action}`);
    }
    if (typeof obj.confidence !== "number" || obj.confidence < 0 || obj.confidence > 1) {
      throw new Error(`confidence out of range: ${obj.confidence}`);
    }
    return {
      action: obj.action,
      reply: obj.reply ?? null,
      confidence: obj.confidence,
      needsEscalation: !!obj.needsEscalation,
      escalationReason: obj.escalationReason ?? null,
      usedKnowledge: !!obj.usedKnowledge,
      missingInformation: obj.missingInformation ?? null,
    };
  }

  shouldEscalate(result: AiReplyResult, threshold: number): boolean {
    if (result.needsEscalation) return true;
    if (result.action === "escalate") return true;
    if (result.confidence < threshold) return true;
    if (!result.reply || !result.reply.trim()) return true;
    return false;
  }

  buildSystemPrompt(hits: KnowledgeSearchHit[]): string {
    const kbBlock = hits.length === 0
      ? "(no knowledge-base content available for this query)"
      : hits
          .map((h, i) => `[KB ${i + 1}] (from "${h.documentFilename}", similarity=${h.similarity.toFixed(2)})\n${h.content}`)
          .join("\n\n");

    return `You are a customer-support assistant replying on WhatsApp on behalf of a business.

Rules:
- Reply ONLY using facts present in the knowledge-base excerpts below. Do NOT invent.
- If the answer is not clearly present, set action="escalate" and explain in escalationReason.
- Keep replies short (1-3 sentences), friendly, in the same language as the customer (Arabic or English).
- Confidence is your honest 0.0-1.0 estimate that the reply is correct and complete given the excerpts.
- If the customer asks to speak to a human, set action="escalate", escalationReason="customer requested human".
- If the message expresses anger, complaint, or threats, set action="escalate", escalationReason="negative sentiment".

Knowledge base excerpts:
${kbBlock}`;
  }

  async generate(ctx: AiReplyContext): Promise<AiReplyOutcome> {
    const hits = await this.search.search(ctx.workspaceId, ctx.inboundText, 5);
    const systemPrompt = this.buildSystemPrompt(hits);

    const userMsg = ctx.contactName
      ? `Customer "${ctx.contactName}" wrote on WhatsApp: ${ctx.inboundText}`
      : `Customer wrote on WhatsApp: ${ctx.inboundText}`;

    const response = await this.openai.client.responses.create({
      model: this.openai.replyModel,
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMsg },
      ],
      text: { format: { type: "json_schema", ...REPLY_JSON_SCHEMA } },
    });

    const raw = (response as { output_text?: string }).output_text;
    if (!raw) throw new Error("openai response had no output_text");

    const parsed = this.parseStructuredOutput(raw);
    const usage = (response as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;

    return {
      ...parsed,
      modelName: this.openai.replyModel,
      promptTokens: usage?.input_tokens,
      completionTokens: usage?.output_tokens,
      sources: hits.map((h) => ({ chunkId: h.chunkId, similarity: h.similarity })),
    };
  }
}
