// Tiny typed fetch wrapper. Reads JWT from localStorage and attaches it.
// Throws ApiError on non-2xx so hooks can show error states.

// Single source of truth for the API origin. Everything that talks to the
// backend (this client, the socket, MediaPicker/ComposeModal/Inbox/Media
// direct fetches) must import this — no local re-definitions, which used to
// drift and defaulted to the wrong port (3001 instead of the dev backend's
// 4100). Set VITE_API_URL to override in any non-dev build.
export const API_BASE =
  (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:4100/api";
const BASE = API_BASE;
const TOKEN_KEY = "aram.token.v1";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export const tokenStore = {
  get(): string | null {
    try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
  },
  set(token: string): void {
    try { localStorage.setItem(TOKEN_KEY, token); } catch { /* ignore */ }
  },
  clear(): void {
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  },
};

// Global "session expired" hook. AuthProvider registers its logout() here so
// that ANY request returning 401 while a token was attached (i.e. the token
// was rejected as expired/invalid — not a login attempt) tears the session
// down and drops back to the login screen, instead of leaving every screen
// stuck in a per-request error state.
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

interface RequestOpts {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
}

async function request<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const tok = tokenStore.get();
  if (tok) headers.Authorization = `Bearer ${tok}`;

  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });

  // A 401 on a request that DID carry a token means the session token was
  // rejected (expired/invalid). Fire the global logout hook. Login/register
  // send no token, so their "invalid credentials" 401s never reach here.
  if (res.status === 401 && tok) {
    onUnauthorized?.();
  }

  if (res.status === 204) return undefined as T;

  const raw = await res.text();
  const data: unknown = raw ? safeJson(raw) : undefined;

  if (!res.ok) {
    const message =
      isObject(data) && typeof data.message === "string"
        ? data.message
        : Array.isArray((data as { message?: unknown })?.message)
          ? (data as { message: string[] }).message.join(", ")
          : `HTTP ${res.status}`;
    throw new ApiError(message, res.status);
  }
  return data as T;
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export const api = {
  get:    <T,>(path: string, signal?: AbortSignal) => request<T>(path, { method: "GET", signal }),
  post:   <T,>(path: string, body?: unknown) => request<T>(path, { method: "POST", body }),
  patch:  <T,>(path: string, body?: unknown) => request<T>(path, { method: "PATCH", body }),
  delete: <T,>(path: string) => request<T>(path, { method: "DELETE" }),
};
