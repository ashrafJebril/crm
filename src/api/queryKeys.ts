// src/api/queryKeys.ts
//
// Single source of truth for React Query cache keys touched by the pipeline
// feature. Every hook and mutation references qk.* — no ad-hoc string keys.
// Adding a new query? Add it here first.

export const qk = {
  pipelines: () => ["pipelines"] as const,

  stageTickets: (
    pipelineId: string,
    stageId: string,
    filters?: { ownerId?: string; q?: string },
  ) => ["tickets", "stage", pipelineId, stageId, filters ?? {}] as const,

  ticket: (id: string) => ["tickets", "detail", id] as const,

  summary: (pipelineId: string) => ["tickets", "summary", pipelineId] as const,

  conversationTickets: (conversationId: string) =>
    ["tickets", "conversation", conversationId] as const,
};
