import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { OpenAiService } from "../openai/openai.service";
import { extractText } from "./parsers";
import { splitIntoChunks, estimateTokens } from "./chunker";
import type { KnowledgeDocumentDto } from "./knowledge.dto";

const ALLOWED_MIME = new Set([
  "application/pdf",
  "text/plain",
  "text/markdown",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

const CHUNK_MAX_CHARS = 1500;
const CHUNK_OVERLAP_CHARS = 200;
const EMBED_BATCH = 96;

@Injectable()
export class KnowledgeService {
  private readonly log = new Logger(KnowledgeService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly openai: OpenAiService,
  ) {}

  async list(workspaceId: string): Promise<KnowledgeDocumentDto[]> {
    const rows = await this.prisma.knowledgeDocument.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(this.toDto);
  }

  async upload(
    workspaceId: string,
    userId: string | null,
    file: Express.Multer.File,
  ): Promise<KnowledgeDocumentDto> {
    if (!file) throw new BadRequestException("No file uploaded");
    if (!ALLOWED_MIME.has(file.mimetype)) {
      throw new BadRequestException(
        `Unsupported file type: ${file.mimetype}. Allowed: PDF, TXT, MD, DOCX.`,
      );
    }
    if (!this.openai.isConfigured()) {
      throw new BadRequestException("OPENAI_API_KEY not configured");
    }

    const doc = await this.prisma.knowledgeDocument.create({
      data: {
        workspaceId,
        filename: file.originalname,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        status: "processing",
        uploadedByUserId: userId,
      },
    });

    try {
      const text = await extractText({
        buffer: file.buffer,
        mimetype: file.mimetype,
        originalname: file.originalname,
      });
      if (!text.trim()) throw new Error("Document is empty or unreadable");

      const chunks = splitIntoChunks(text, {
        maxChars: CHUNK_MAX_CHARS,
        overlapChars: CHUNK_OVERLAP_CHARS,
      });
      if (chunks.length === 0) throw new Error("No chunks extracted");

      const embeddings: number[][] = [];
      for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
        const slice = chunks.slice(i, i + EMBED_BATCH);
        const vecs = await this.openai.embed(slice);
        embeddings.push(...vecs);
      }
      if (embeddings.length !== chunks.length) {
        throw new Error(
          `embedding count mismatch: chunks=${chunks.length} vecs=${embeddings.length}`,
        );
      }

      for (let i = 0; i < chunks.length; i++) {
        const vectorLiteral = `[${embeddings[i].join(",")}]`;
        await this.prisma.$executeRawUnsafe(
          `INSERT INTO "KnowledgeChunk"
             ("id","workspaceId","knowledgeDocumentId","chunkIndex","content","tokenCount","embedding")
           VALUES ($1, $2, $3, $4, $5, $6, $7::vector)`,
          cuid(),
          workspaceId,
          doc.id,
          i,
          chunks[i],
          estimateTokens(chunks[i]),
          vectorLiteral,
        );
      }

      const updated = await this.prisma.knowledgeDocument.update({
        where: { id: doc.id },
        data: { status: "ready", chunkCount: chunks.length },
      });
      return this.toDto(updated);
    } catch (err) {
      const msg = (err as Error).message;
      this.log.error(`KB upload failed for doc=${doc.id}: ${msg}`);
      const failed = await this.prisma.knowledgeDocument.update({
        where: { id: doc.id },
        data: { status: "failed", errorText: msg.slice(0, 500) },
      });
      return this.toDto(failed);
    }
  }

  async remove(workspaceId: string, id: string): Promise<{ ok: true }> {
    const row = await this.prisma.knowledgeDocument.findFirst({
      where: { id, workspaceId },
    });
    if (!row) throw new NotFoundException("Knowledge document not found");
    await this.prisma.knowledgeDocument.delete({ where: { id: row.id } });
    return { ok: true };
  }

  private toDto = (r: {
    id: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    status: string;
    errorText: string | null;
    chunkCount: number;
    createdAt: Date;
  }): KnowledgeDocumentDto => ({
    id: r.id,
    filename: r.filename,
    mimeType: r.mimeType,
    sizeBytes: r.sizeBytes,
    status: r.status,
    errorText: r.errorText,
    chunkCount: r.chunkCount,
    createdAt: r.createdAt.toISOString(),
  });
}

function cuid(): string {
  return (
    "c" +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 10)
  );
}
