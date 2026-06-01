-- DropIndex
DROP INDEX "KnowledgeChunk_embedding_hnsw_idx";

-- CreateTable
CREATE TABLE "AiReply" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "inboundMessageId" TEXT,
    "outboundMessageId" TEXT,
    "action" TEXT NOT NULL,
    "replyText" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL,
    "needsEscalation" BOOLEAN NOT NULL,
    "escalationReason" TEXT,
    "usedKnowledge" BOOLEAN NOT NULL,
    "missingInformation" TEXT,
    "modelName" TEXT NOT NULL,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "sources" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiReply_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiReply_workspaceId_idx" ON "AiReply"("workspaceId");

-- CreateIndex
CREATE INDEX "AiReply_conversationId_idx" ON "AiReply"("conversationId");

-- AddForeignKey
ALTER TABLE "AiReply" ADD CONSTRAINT "AiReply_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiReply" ADD CONSTRAINT "AiReply_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiReply" ADD CONSTRAINT "AiReply_inboundMessageId_fkey" FOREIGN KEY ("inboundMessageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiReply" ADD CONSTRAINT "AiReply_outboundMessageId_fkey" FOREIGN KEY ("outboundMessageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;
