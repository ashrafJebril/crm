import { ApiError, api } from "@/api/client";

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

/** Multipart upload through the shared client (token, 401 logout and error handling). */
export function uploadImport(file: File, kind: ImportKind): Promise<ImportUpload> {
  const fd = new FormData();
  fd.append("kind", kind);
  fd.append("file", file);
  return api.postForm<ImportUpload>("/imports", fd);
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

/**
 * POST /contacts/export: the JSON body carries the filter and, for an explicit
 * selection, its ids (no URL length limit). `filterOnly` is used when the
 * selection came from "select all matching", so the server applies the filter
 * itself instead of receiving up to 10 000 ids.
 */
export function exportBody(filterQuery: string, ids: string[], filterOnly: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = Object.fromEntries(new URLSearchParams(filterQuery));
  if (ids.length && !filterOnly) body.ids = ids;
  return body;
}

/** Goes through the shared client, so the token never appears in a URL and a 401 logs out. */
export async function downloadContactsExport(filterQuery: string, ids: string[], filterOnly = false): Promise<void> {
  const { blob, filename } = await api.postBlob("/contacts/export", exportBody(filterQuery, ids, filterOnly));
  saveBlob(blob, filename ?? "contacts.csv");
}
