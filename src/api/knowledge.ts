import { API_BASE, ApiError, api, tokenStore } from "./client";

const BASE = API_BASE;

export interface KnowledgeDocument {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  status: string; // "pending" | "processing" | "ready" | "failed"
  errorText: string | null;
  chunkCount: number;
  createdAt: string;
}

export function listKnowledge(signal?: AbortSignal): Promise<KnowledgeDocument[]> {
  return api.get<KnowledgeDocument[]>("/knowledge/documents", signal);
}

export async function uploadKnowledge(file: File): Promise<KnowledgeDocument> {
  const fd = new FormData();
  fd.append("file", file);

  // Direct fetch — must NOT set Content-Type so the browser writes the multipart boundary.
  const headers: Record<string, string> = {};
  const tok = tokenStore.get();
  if (tok) headers.Authorization = `Bearer ${tok}`;

  const res = await fetch(`${BASE}/knowledge/documents`, {
    method: "POST",
    headers,
    body: fd,
  });
  const text = await res.text();
  const data: unknown = text ? safeJson(text) : undefined;
  if (!res.ok) {
    const msg =
      typeof data === "object" && data !== null && "message" in data
        ? String((data as { message: unknown }).message)
        : `HTTP ${res.status}`;
    throw new ApiError(msg, res.status);
  }
  return data as KnowledgeDocument;
}

export function deleteKnowledge(id: string): Promise<void> {
  return api.delete<void>(`/knowledge/documents/${id}`);
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}
