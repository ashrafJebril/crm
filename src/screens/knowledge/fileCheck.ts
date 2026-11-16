import { KB_BATCH_MAX, KB_EXTENSIONS, KB_FILE_MAX_BYTES } from "./knowledgeConstants";

/**
 * SP-21 upload checks before anything is sent (the backend checks again, and
 * a batch with one bad file creates nothing). Returns the error key and
 * extras the server would answer with, or null when the batch looks fine.
 */
export function checkBatch(files: { name: string; size: number }[]): { key: string; extra: Record<string, unknown> } | null {
  if (files.length === 0) return null;
  if (files.length > KB_BATCH_MAX) return { key: "knowledge.batch_too_large", extra: { max: KB_BATCH_MAX } };
  for (const f of files) {
    const ext = /\.([^.\\/]+)$/.exec(f.name)?.[1]?.toLowerCase() ?? "";
    if (!(KB_EXTENSIONS as readonly string[]).includes(ext)) return { key: "knowledge.file_type", extra: { fileName: f.name } };
    if (f.size > KB_FILE_MAX_BYTES) return { key: "knowledge.file_too_large", extra: { maxBytes: KB_FILE_MAX_BYTES, fileName: f.name } };
  }
  return null;
}
