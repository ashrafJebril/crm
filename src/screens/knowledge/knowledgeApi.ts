import { api } from "@/api/client";
import { saveBlob } from "@/screens/contacts/import/importApi";
import type { KnowledgeSource, TypedKind, WebsiteSchedule } from "@/lib/types";

/** SP-21 knowledge routes (backend/src/knowledge-sources). */

export const SOURCES_PATH = "/knowledge/sources";
export const sourcesPath = (kind?: KnowledgeSource["kind"]) => (kind ? `${SOURCES_PATH}?kind=${kind}` : SOURCES_PATH);
export const previewPath = (id: string) => `${SOURCES_PATH}/${encodeURIComponent(id)}/preview`;
export const pagesPath = (id: string, state?: string, cursor?: string) => {
  const q = new URLSearchParams();
  if (state) q.set("state", state);
  if (cursor) q.set("cursor", cursor);
  const s = q.toString();
  return `${SOURCES_PATH}/${encodeURIComponent(id)}/pages${s ? `?${s}` : ""}`;
};

export type SourceList = { items: KnowledgeSource[] };

export const putContent = (bodyJson: unknown, version: number) => api.put<KnowledgeSource>("/knowledge/content", { bodyJson, version });
export const putGuidelines = (body: string, version: number) => api.put<KnowledgeSource>("/knowledge/guidelines", { body, version });
export const createFaq = (question: string, answer: string) => api.post<KnowledgeSource>("/knowledge/faqs", { question, answer });
export const patchFaq = (id: string, body: { question?: string; answer?: string; version: number }) =>
  api.patch<KnowledgeSource>(`/knowledge/faqs/${encodeURIComponent(id)}`, body);
export const reorderFaqs = (ids: string[]) => api.post<SourceList>("/knowledge/faqs/reorder", { ids });
export const deleteSource = (id: string) => api.delete<{ ok: true }>(`${SOURCES_PATH}/${encodeURIComponent(id)}`);
export const reprocessSource = (id: string) => api.post<KnowledgeSource>(`${SOURCES_PATH}/${encodeURIComponent(id)}/reprocess`);

/** Multipart `files` (one part per file), optional `typedKind` and `acceptValidRows`. */
export function uploadKnowledgeFiles(files: File[], opts: { typedKind?: TypedKind; acceptValidRows?: boolean } = {}) {
  const fd = new FormData();
  for (const f of files) fd.append("files", f, f.name);
  if (opts.typedKind) fd.append("typedKind", opts.typedKind);
  if (opts.acceptValidRows) fd.append("acceptValidRows", "true");
  return api.postForm<SourceList>("/knowledge/files", fd);
}

export async function downloadSourceFile(id: string, fallbackName: string): Promise<void> {
  const { blob, filename } = await api.getBlob(`${SOURCES_PATH}/${encodeURIComponent(id)}/file`);
  saveBlob(blob, filename ?? fallbackName);
}

export async function downloadTypedTemplate(kind: TypedKind): Promise<void> {
  const { blob, filename } = await api.getBlob(`/knowledge/templates/${kind}`);
  saveBlob(blob, filename ?? `kewy-${kind}-template.xlsx`);
}

export interface WebsiteCheck {
  ok: true;
  normalizedUrl: string;
  host: string;
  robotsAllowed: boolean;
  sitemapPages: number | null;
}

export const checkWebsite = (url: string) => api.post<WebsiteCheck>("/knowledge/websites/check", { url });
export const createWebsite = (body: { url: string; scope: "site" | "path"; schedule: WebsiteSchedule }) =>
  api.post<KnowledgeSource>("/knowledge/websites", body);
export const patchWebsite = (id: string, body: { schedule?: WebsiteSchedule; paused?: boolean; version: number }) =>
  api.patch<KnowledgeSource>(`/knowledge/websites/${encodeURIComponent(id)}`, body);
export const refreshWebsite = (id: string) => api.post<KnowledgeSource>(`/knowledge/websites/${encodeURIComponent(id)}/refresh`);
