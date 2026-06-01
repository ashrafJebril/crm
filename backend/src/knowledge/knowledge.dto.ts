export interface KnowledgeDocumentDto {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  status: string;
  errorText: string | null;
  chunkCount: number;
  createdAt: string;
}
