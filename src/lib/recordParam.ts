import { getHashParam, setHashParam, splitHash } from "./hashState";

export const RECORD_KINDS = ["contact", "conversation", "ticket", "booking", "campaign"] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];
export interface RecordRef {
  kind: RecordKind;
  id: string;
}

export function isRecordKind(v: unknown): v is RecordKind {
  return typeof v === "string" && (RECORD_KINDS as readonly string[]).includes(v);
}

/** The record named by `#/<route>?record=<kind>:<id>`; anything malformed
 *  (unknown kind, empty id, no colon) is ignored. */
export function parseRecordParam(hash: string): RecordRef | null {
  const raw = getHashParam(hash, "record");
  if (!raw) return null;
  const i = raw.indexOf(":");
  if (i <= 0) return null;
  const kind = raw.slice(0, i);
  const id = raw.slice(i + 1);
  if (!isRecordKind(kind) || !id) return null;
  return { kind, id };
}

/** The hash with `record` set (or removed for null); every other param is kept. */
export function withRecord(hash: string, rec: RecordRef | null): string {
  const { path } = splitHash(hash);
  const base = path.replace(/^#\/?/, "") ? hash : `#/dashboard${hash.includes("?") ? hash.slice(hash.indexOf("?")) : ""}`;
  return setHashParam(base, "record", rec ? `${rec.kind}:${rec.id}` : null);
}

export function closeRecordHash(hash: string): string {
  return withRecord(hash, null);
}

/** Hash to assign (pushing a history entry) to open `rec`; null when it is already the open record. */
export function recordNavTarget(hash: string, rec: RecordRef): string | null {
  const cur = parseRecordParam(hash);
  if (cur && cur.kind === rec.kind && cur.id === rec.id) return null;
  return withRecord(hash, rec);
}
