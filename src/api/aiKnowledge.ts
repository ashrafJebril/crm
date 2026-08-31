import { api } from "./client";

/**
 * The AI's knowledge base, via the CRM's own proxy at `/ai/knowledge`.
 *
 * Note what is NOT here: a tenant/workspace id. The backend stamps it from the
 * session JWT and rejects a body that carries one, so the browser has no say in
 * which salon it is reading — and the kewy-ai admin secret never leaves the
 * server. Do not add a tenantId field to these calls; it will 400.
 *
 * Distinct from `./knowledge.ts`, which is an older unused document-upload
 * surface against a different backend route.
 */

export const KNOWLEDGE_KINDS = [
  "POLICY",
  "FAQ",
  "SERVICE_DESCRIPTION",
  "PROMOTION",
  "TONE",
  "OTHER",
] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

/** kewy-ai's cap. Enforced in the UI too so a long paste fails before the
 *  round trip, not after — every chunk of this text is a paid embedding. */
export const BODY_MAX = 100_000;
export const TITLE_MAX = 200;

export interface AiKnowledgeDoc {
  id: string;
  tenantId: string;
  kind: KnowledgeKind;
  title: string;
  body: string;
  /** Non-null = pulled from hjz by the sync, not written by the owner. */
  sourceRef: string | null;
  syncedAt: string | null;
  updatedAt: string;
  /** False for synced docs — the next sync would silently revert an edit, so
   *  the UI renders them read-only rather than offering a button that lies. */
  editable: boolean;
}

export interface SaveDocResult extends AiKnowledgeDoc {
  /** How many embedded chunks the save produced — proof it actually indexed. */
  chunksWritten: number;
}

export interface SyncResult {
  synced?: unknown[];
}

export function saveDoc(input: {
  id?: string;
  title: string;
  body: string;
  kind: KnowledgeKind;
}): Promise<SaveDocResult> {
  return api.post<SaveDocResult>("/ai/knowledge/docs", input);
}

export function deleteDoc(id: string): Promise<{ ok: true; id: string }> {
  return api.delete<{ ok: true; id: string }>(`/ai/knowledge/docs/${id}`);
}

export function resyncFromHjz(): Promise<SyncResult> {
  return api.post<SyncResult>("/ai/knowledge/sync");
}
