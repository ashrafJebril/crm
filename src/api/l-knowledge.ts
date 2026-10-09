import { API_BASE, ApiError, tokenStore } from "./client";

export interface LDocument {
  id: string;
  title: string;
  source_type: string;
  status: string; // "pending" | "processing" | "ready" | "failed"
  meta: Record<string, unknown>;
  created_at: string;
}

/**
 * Upload a file to the Kewy AI agent's knowledge base. Multipart — can't go
 * through the JSON `api` client (see src/api/uploadMedia.ts for the same
 * pattern). Throws an Error carrying the server's message on rejection.
 */
export async function uploadKnowledgeDocument(file: File): Promise<LDocument> {
  const fd = new FormData();
  fd.append("file", file);
  const token = tokenStore.get();
  const res = await fetch(`${API_BASE}/integrations/l/knowledge`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
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
  return data as LDocument;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
