import { EMPTY_FILTER, type InboxFilter, type InboxView } from "./inboxFilters";

const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

const BUCKETS = new Set([
  "all", "mine", "unassigned", "unread", "human", "pending_customer", "resolved", "closed", "spam",
]);

/** Unicode-safe base64 of the filter JSON (label/tag names may be Arabic). */
export function encodeFilter(f: InboxFilter): string {
  return btoa(encodeURIComponent(JSON.stringify(f)));
}

/** Defensive inverse of encodeFilter; anything malformed yields EMPTY_FILTER. */
export function decodeFilter(s: string | null | undefined): InboxFilter {
  if (!s) return EMPTY_FILTER;
  try {
    const o = JSON.parse(decodeURIComponent(atob(s)));
    if (!o || typeof o !== "object" || Array.isArray(o)) return EMPTY_FILTER;
    return {
      bucket: BUCKETS.has(o.bucket) ? o.bucket : "all",
      assigneeIds: strs(o.assigneeIds),
      labelIds: strs(o.labelIds),
      tags: strs(o.tags),
      lifecycles: strs(o.lifecycles),
      from: typeof o.from === "string" && o.from ? o.from : undefined,
      to: typeof o.to === "string" && o.to ? o.to : undefined,
      escalatedOnly: o.escalatedOnly === true,
    };
  } catch {
    return EMPTY_FILTER;
  }
}

function split(hash: string): { path: string; params: URLSearchParams } {
  const i = hash.indexOf("?");
  return i < 0
    ? { path: hash, params: new URLSearchParams() }
    : { path: hash.slice(0, i), params: new URLSearchParams(hash.slice(i + 1)) };
}

export function readFilterFromHash(hash: string): InboxFilter {
  return decodeFilter(split(hash).params.get("f"));
}

/** Returns the hash with `f=` set (removed for the empty filter); other params are kept. */
export function writeFilterToHash(hash: string, f: InboxFilter): string {
  const { path, params } = split(hash);
  if (encodeFilter(f) === encodeFilter(decodeFilter(null))) params.delete("f");
  else params.set("f", encodeFilter(f));
  const q = params.toString();
  return q ? `${path}?${q}` : path;
}

const VIEWS = new Set<InboxView>(["list", "table", "board"]);

/** Reads `v=`; anything but table/board is "list". */
export function readViewFromHash(hash: string): InboxView {
  const v = split(hash).params.get("v");
  return VIEWS.has(v as InboxView) ? (v as InboxView) : "list";
}

/** Returns the hash with `v=` set (removed for "list"); other params are kept. */
export function writeViewToHash(hash: string, v: InboxView): string {
  const { path, params } = split(hash);
  if (v === "list") params.delete("v");
  else params.set("v", v);
  const q = params.toString();
  return q ? `${path}?${q}` : path;
}
