import { Injectable, Logger } from "@nestjs/common";
import OpenAI from "openai";

@Injectable()
export class OpenAiService {
  private readonly log = new Logger(OpenAiService.name);
  private _client: OpenAI | null = null;

  get client(): OpenAI {
    if (this._client) return this._client;
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY is not set. AI features require a key in backend/.env",
      );
    }
    this._client = new OpenAI({ apiKey });
    return this._client;
  }

  isConfigured(): boolean {
    return !!process.env.OPENAI_API_KEY;
  }

  get replyModel(): string {
    return process.env.OPENAI_REPLY_MODEL || "gpt-4o-mini";
  }

  get embedModel(): string {
    return process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small";
  }

  get confidenceThreshold(): number {
    const raw = process.env.AI_REPLY_CONFIDENCE_THRESHOLD;
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? parsed : 0.75;
  }

  async embed(inputs: string[]): Promise<number[][]> {
    if (inputs.length === 0) return [];
    const res = await this.client.embeddings.create({
      model: this.embedModel,
      input: inputs,
    });
    return [...res.data]
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding as number[]);
  }
}
