import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { OpenAiService } from "../openai/openai.service";

export interface KnowledgeSearchHit {
  chunkId: string;
  documentId: string;
  documentFilename: string;
  content: string;
  similarity: number;
}

@Injectable()
export class KnowledgeSearchService {
  private readonly log = new Logger(KnowledgeSearchService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly openai: OpenAiService,
  ) {}

  /**
   * Embed the query and return the top-K most similar chunks for a workspace.
   * Uses pgvector cosine distance (<=>); similarity = 1 - distance.
   */
  async search(
    workspaceId: string,
    query: string,
    topK = 5,
  ): Promise<KnowledgeSearchHit[]> {
    if (!query.trim()) return [];
    const [vec] = await this.openai.embed([query]);
    const literal = `[${vec.join(",")}]`;

    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        chunkId: string;
        documentId: string;
        documentFilename: string;
        content: string;
        distance: number;
      }>
    >(
      `SELECT
         c."id"                   AS "chunkId",
         c."knowledgeDocumentId"  AS "documentId",
         d."filename"             AS "documentFilename",
         c."content"              AS "content",
         (c."embedding" <=> $1::vector) AS "distance"
       FROM "KnowledgeChunk" c
       JOIN "KnowledgeDocument" d ON d."id" = c."knowledgeDocumentId"
       WHERE c."workspaceId" = $2 AND d."status" = 'ready'
       ORDER BY c."embedding" <=> $1::vector ASC
       LIMIT $3`,
      literal,
      workspaceId,
      topK,
    );

    return rows.map((r) => ({
      chunkId: r.chunkId,
      documentId: r.documentId,
      documentFilename: r.documentFilename,
      content: r.content,
      similarity: 1 - Number(r.distance),
    }));
  }
}
