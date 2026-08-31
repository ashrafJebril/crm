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

/* ─── The assistant's on/off switch ─────────────────────────────────────── */

/**
 * Three separate things, deliberately not conflated:
 *
 *  - `aiEnabled` is the emergency stop. Off means the agent is never invoked:
 *    no model call, no cost. Inbound customer messages are STILL saved so a
 *    human can answer — turning the AI off never loses a message.
 *  - `autonomyMode` is whether the reply is SENT. SHADOW still runs the model
 *    and still costs money; it writes a draft into the thread. AUTONOMOUS
 *    delivers to the customer.
 *  - Conversation.aiEnabled (the per-thread toggle in the Inbox) is a different
 *    switch entirely and is not touched from here.
 */
export const AUTONOMY_MODES = ["SHADOW", "AUTONOMOUS"] as const;
export type AutonomyMode = (typeof AUTONOMY_MODES)[number];

/** Upstream's cap on the disable reason. */
export const REASON_MAX = 500;

export interface AiSettings {
  /** Effective state — the backend already folds in an operator kill switch. */
  aiEnabled: boolean;
  autonomyMode: AutonomyMode;
  personaName: string;
  locale: string;
  dailyCostCapJod: number | null;
  configured: boolean;
}

export interface ToggleResult {
  aiEnabled: boolean;
  /** False when it was already in that state — nothing actually changed. */
  changed: boolean;
  reason?: string;
}

/** `reason` is REQUIRED when turning it off; the backend 400s without one. */
export function setAiEnabled(enabled: boolean, reason?: string): Promise<ToggleResult> {
  return api.post<ToggleResult>("/ai/settings/toggle", { enabled, ...(reason ? { reason } : {}) });
}

export function setAutonomyMode(autonomyMode: AutonomyMode): Promise<AiSettings> {
  return api.patch<AiSettings>("/ai/settings", { autonomyMode });
}
