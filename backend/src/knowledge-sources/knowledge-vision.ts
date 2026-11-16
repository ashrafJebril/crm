/**
 * SP-21 vision transcription: the only Claude call in SP-21, through the
 * shared ClaudeService (ruling 1). The file is untrusted input; the answer is
 * plain text, accepted only on `end_turn`, length-capped, and stored as
 * knowledge text. It is never executed, never shown as HTML, never changes a
 * setting. Neither the file nor the transcription is logged.
 */
import { Injectable } from "@nestjs/common";
import { ClaudeService } from "../ai/claude.service";
import { ClaudeFailure } from "../ai/claude-errors";
import { KB_TEXT_MAX } from "./knowledge-constants";
import { KnowledgeFailure } from "./knowledge-errors";

/** Env var naming the transcription model (default `claude-opus-5-5`, ruling 1). */
export const KNOWLEDGE_MODEL_ENV = "KNOWLEDGE_EXTRACT_MODEL";
/**
 * Largest image sent as a base64 block: the Messages API refuses images over
 * 5 MB (base64), i.e. ~3.75 MB of raw bytes. Larger images would need
 * re-encoding, which needs an image library the project does not have; they
 * fail with `knowledge.unreadable` (copy asks for a smaller image).
 */
export const VISION_IMAGE_MAX_BYTES = Math.floor((5 * 1024 * 1024 * 3) / 4);

export type VisionMediaType = "application/pdf" | "image/jpeg" | "image/png" | "image/webp";

export interface KnowledgeVisionPort {
  available(): boolean;
  /** Plain text of the file; throws KnowledgeFailure (`ai_unavailable`, `ai_failed`, `unreadable`). */
  transcribe(buffer: Buffer, mediaType: VisionMediaType): Promise<string>;
}

@Injectable()
export class KnowledgeVision implements KnowledgeVisionPort {
  constructor(private readonly claude: ClaudeService) {}

  available(): boolean {
    return this.claude.available();
  }

  async transcribe(buffer: Buffer, mediaType: VisionMediaType): Promise<string> {
    if (!this.claude.available()) throw new KnowledgeFailure("knowledge.ai_unavailable");
    const kind = mediaType === "application/pdf" ? "pdf" : "image";
    if (kind === "image" && buffer.length > VISION_IMAGE_MAX_BYTES) throw new KnowledgeFailure("knowledge.unreadable");
    try {
      return await this.claude.transcribe({
        kind,
        base64: buffer.toString("base64"),
        mediaType,
        model: this.claude.model(KNOWLEDGE_MODEL_ENV),
        maxChars: KB_TEXT_MAX,
      });
    } catch (e) {
      if (e instanceof ClaudeFailure) {
        if (e.key === "ai_unavailable") throw new KnowledgeFailure("knowledge.ai_unavailable");
        // A PDF whose transcription does not fit one reply is too long for us;
        // the partial text is never stored.
        if (e.stopReason === "max_tokens" && kind === "pdf") throw new KnowledgeFailure("knowledge.pdf_too_long");
        throw new KnowledgeFailure("knowledge.ai_failed", e.transient);
      }
      throw new KnowledgeFailure("knowledge.ai_failed");
    }
  }
}
