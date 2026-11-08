/** Shared helpers for state kept in the hash query (`#/route?key=<base64 json>`). */

/** Unicode-safe base64 of JSON (labels/tag names may be Arabic). */
export function encodeJson(v: unknown): string {
  return btoa(encodeURIComponent(JSON.stringify(v)));
}

/** Defensive inverse of encodeJson; anything malformed yields null. */
export function decodeJson(s: string | null | undefined): unknown {
  if (!s) return null;
  try {
    return JSON.parse(decodeURIComponent(atob(s)));
  } catch {
    return null;
  }
}

export function splitHash(hash: string): { path: string; params: URLSearchParams } {
  const i = hash.indexOf("?");
  return i < 0
    ? { path: hash, params: new URLSearchParams() }
    : { path: hash.slice(0, i), params: new URLSearchParams(hash.slice(i + 1)) };
}

export function getHashParam(hash: string, key: string): string | null {
  return splitHash(hash).params.get(key);
}

/** Returns the hash with `key` set (removed when value is null); other params are kept. */
export function setHashParam(hash: string, key: string, value: string | null): string {
  const { path, params } = splitHash(hash);
  if (value === null) params.delete(key);
  else params.set(key, value);
  const q = params.toString();
  return q ? `${path}?${q}` : path;
}
