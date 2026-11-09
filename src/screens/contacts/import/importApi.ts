import { API_BASE, ApiError, api, tokenStore } from "@/api/client";

export type ImportKind = "contacts" | "audience";
export type ImportStatus = "uploaded" | "previewed" | "running" | "done" | "failed" | "cancelled";

export interface ImportUpload {
  id: string;
  fileName: string;
  headers: string[];
  sampleRows: string[][];
  totalRows: number;
  suggestedMapping: Record<string, string>;
}

export interface ImportOptions {
  matchBy?: "phone_then_email" | "phone" | "email";
  updateExisting?: boolean;
  tags?: string[];
  ownerId?: string;
  groupId?: string;
  newGroupName?: string;
  pipeline?: { pipelineId: string; stageId?: string };
}

export interface ImportRowError { row: number; column: string | null; key: string }

export interface ImportPreview {
  counts: { new: number; update: number; unchanged: number; invalid: number; duplicateInFile: number };
  invalidSamples: ImportRowError[];
}

export interface ImportJob {
  id: string;
  kind: ImportKind;
  status: ImportStatus;
  fileName: string;
  totalRows: number;
  processed: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  duplicateInFile: number;
  errors: ImportRowError[];
  startedAt: string | null;
  finishedAt: string | null;
  options?: ImportOptions & { groupId?: string };
}

/** Backend message key from an error (400s carry `messageKey` and use the key as `message`). */
export function errorKey(e: unknown): string | undefined {
  if (e instanceof ApiError) {
    const b = e.body as { messageKey?: string } | undefined;
    return b?.messageKey ?? e.message;
  }
  return undefined;
}

/** Multipart upload; goes around the JSON client. */
export async function uploadImport(file: File, kind: ImportKind): Promise<ImportUpload> {
  const fd = new FormData();
  fd.append("kind", kind);
  fd.append("file", file);
  const token = tokenStore.get();
  const res = await fetch(`${API_BASE}/imports`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: fd,
  });
  const raw = await res.text();
  let data: unknown;
  try { data = raw ? JSON.parse(raw) : undefined; } catch { data = undefined; }
  if (!res.ok) {
    const b = (data ?? {}) as { message?: string; messageKey?: string };
    throw new ApiError(b.messageKey ?? (typeof b.message === "string" ? b.message : `HTTP ${res.status}`), res.status, undefined, data);
  }
  return data as ImportUpload;
}

export const previewImport = (id: string, mapping: Record<string, string>, options: ImportOptions) =>
  api.post<ImportPreview>(`/imports/${id}/preview`, { mapping, options });
export const runImport = (id: string) => api.post<ImportJob>(`/imports/${id}/run`);
export const cancelImport = (id: string) => api.post<ImportJob>(`/imports/${id}/cancel`);
export const getImport = (id: string, signal?: AbortSignal) => api.get<ImportJob>(`/imports/${id}`, signal);
export const listImports = (limit = 10) => api.get<ImportJob[]>(`/imports?limit=${limit}`);

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** The token travels in the Authorization header, so fetch a blob and save it (never put it in a URL). */
export async function downloadContactsExport(filterQuery: string, ids: string[]): Promise<void> {
  const p = new URLSearchParams(filterQuery);
  if (ids.length) p.set("ids", ids.join(","));
  const token = tokenStore.get();
  const res = await fetch(`${API_BASE}/contacts/export?${p.toString()}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = (await res.json()) as { message?: string }; if (j.message) msg = j.message; } catch { /* keep */ }
    throw new ApiError(msg, res.status);
  }
  const cd = res.headers.get("Content-Disposition") ?? "";
  const m = /filename="?([^";]+)"?/i.exec(cd);
  saveBlob(await res.blob(), m?.[1] ?? "contacts.csv");
}
