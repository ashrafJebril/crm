-- HNSW cosine-similarity index for fast top-K vector retrieval on KB chunks.
-- Cosine distance operator (<=>) matches OpenAI embeddings which are
-- L2-normalised, so cosine and dot-product rankings are equivalent.
CREATE INDEX IF NOT EXISTS "KnowledgeChunk_embedding_hnsw_idx"
  ON "KnowledgeChunk"
  USING hnsw (embedding vector_cosine_ops);
