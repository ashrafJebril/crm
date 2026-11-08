import type { CustomFieldType } from "@/lib/types";
import { decodeJson, encodeJson } from "@/lib/hashState";

export type FieldOp = "eq" | "contains" | "gt" | "lt" | "set" | "unset";
const ALL_OPS: FieldOp[] = ["eq", "contains", "gt", "lt", "set", "unset"];

export interface FieldFilter {
  defId: string;
  op: FieldOp;
  value?: string;
}

export interface ContactFilter {
  lifecycle: string[];
  tags: string[];
  tagMode: "any" | "all";
  /** A user id, or "none" for unassigned. */
  ownerId: string | null;
  pipelineId: string | null;
  stageId: string | null;
  optOut: boolean | null;
  notALead: boolean | null;
  fields: FieldFilter[];
}

export const EMPTY_CONTACT_FILTER: ContactFilter = {
  lifecycle: [],
  tags: [],
  tagMode: "any",
  ownerId: null,
  pipelineId: null,
  stageId: null,
  optOut: null,
  notALead: null,
  fields: [],
};

/** Search/segment live outside the filter state but ride on the same requests. */
export interface FilterExtras {
  q?: string;
  segmentId?: string | null;
}

/** Operators the backend accepts per field type. */
export function opsForType(type: CustomFieldType): FieldOp[] {
  switch (type) {
    case "text": return ["eq", "contains", "set", "unset"];
    case "number":
    case "date": return ["eq", "gt", "lt", "set", "unset"];
    default: return ["eq", "set", "unset"];
  }
}

const cleanFields = (fields: FieldFilter[]) =>
  fields.map((x) => (x.op === "set" || x.op === "unset" ? { defId: x.defId, op: x.op } : { defId: x.defId, op: x.op, value: x.value ?? "" }));

/** Query params for GET /contacts/page and /contacts/ids. */
export function toQuery(f: ContactFilter, extras: FilterExtras = {}): URLSearchParams {
  const p = new URLSearchParams();
  if (extras.q) p.set("q", extras.q);
  if (extras.segmentId) p.set("segmentId", extras.segmentId);
  if (f.lifecycle.length) p.set("lifecycle", f.lifecycle.join(","));
  if (f.tags.length) {
    p.set("tags", f.tags.join(","));
    if (f.tagMode === "all") p.set("tagMode", "all");
  }
  if (f.ownerId) p.set("ownerId", f.ownerId);
  if (f.pipelineId) {
    p.set("pipelineId", f.pipelineId);
    if (f.stageId) p.set("stageId", f.stageId);
  }
  if (f.optOut !== null) p.set("optOut", String(f.optOut));
  if (f.notALead !== null) p.set("notALead", String(f.notALead));
  if (f.fields.length) p.set("fields", JSON.stringify(cleanFields(f.fields)));
  return p;
}

/** Number of active facets (each custom-field condition counts). */
export function activeCount(f: ContactFilter): number {
  return (
    (f.lifecycle.length ? 1 : 0) +
    (f.tags.length ? 1 : 0) +
    (f.ownerId ? 1 : 0) +
    (f.pipelineId ? 1 : 0) +
    (f.optOut !== null ? 1 : 0) +
    (f.notALead !== null ? 1 : 0) +
    f.fields.length
  );
}

/** True when a select-all response (started with `start`) still belongs to the current
 *  listing and an untouched selection; otherwise it must be discarded. */
export function isSelectAllCurrent(
  start: { query: string; selectionVersion: number },
  now: { query: string; selectionVersion: number },
): boolean {
  return start.query === now.query && start.selectionVersion === now.selectionVersion;
}

/** Drops field conditions whose definition is not in `defIds` (deleted/archived/foreign). */
export function pruneFieldFilters(f: ContactFilter, defIds: Set<string>): ContactFilter {
  const fields = f.fields.filter((x) => defIds.has(x.defId));
  return fields.length === f.fields.length ? f : { ...f, fields };
}

export const isEmptyFilter = (f: ContactFilter) => activeCount(f) === 0;

export const encodeContactFilter = (f: ContactFilter): string => encodeJson(f);

const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : [];
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

/** Defensive inverse of encodeContactFilter; malformed input yields the empty filter. */
export function decodeContactFilter(s: string | null | undefined): ContactFilter {
  const o = decodeJson(s) as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || Array.isArray(o)) return EMPTY_CONTACT_FILTER;
  const fields: FieldFilter[] = Array.isArray(o.fields)
    ? o.fields.flatMap((x): FieldFilter[] => {
        const r = x as Record<string, unknown> | null;
        if (!r || typeof r.defId !== "string" || !r.defId || !ALL_OPS.includes(r.op as FieldOp)) return [];
        const op = r.op as FieldOp;
        return [typeof r.value === "string" && op !== "set" && op !== "unset" ? { defId: r.defId, op, value: r.value } : { defId: r.defId, op }];
      })
    : [];
  const pipelineId = str(o.pipelineId);
  return {
    lifecycle: strs(o.lifecycle),
    tags: strs(o.tags),
    tagMode: o.tagMode === "all" ? "all" : "any",
    ownerId: str(o.ownerId),
    pipelineId,
    stageId: pipelineId ? str(o.stageId) : null,
    optOut: bool(o.optOut),
    notALead: bool(o.notALead),
    fields,
  };
}
