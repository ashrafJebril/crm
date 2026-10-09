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
  // Backend error code (e.g. "ADS_SERVICE_BUSY", "PROMPT_NOT_AVAILABLE") from a
  // flat { code, message } error body. Optional — most endpoints don't send one.
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
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

  if (!res.ok) throw errorFromBody(data, res.status);
  return data as T;
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// Shared non-2xx → ApiError mapping for `request` and `postStream`'s pre-flush
// branch. Handles both the legacy { message } / { message: string[] } bodies
// and the ads endpoints' flat { code, message } bodies (code is just ignored
// when absent, so nothing else breaks).
function errorFromBody(data: unknown, status: number): ApiError {
  const message =
    isObject(data) && typeof data.message === "string"
      ? data.message
      : Array.isArray((data as { message?: unknown })?.message)
        ? (data as { message: string[] }).message.join(", ")
        : `HTTP ${status}`;
  const code = isObject(data) && typeof data.code === "string" ? data.code : undefined;
  return new ApiError(message, status, code);
}

// POST that reads a Server-Sent Events stream instead of a single JSON body —
// used by the ads chat endpoint, which holds the connection open (heartbeats)
// while the agent loop runs, then sends ONE terminal frame: `event: done`
// (the full JSON result) or `event: error` ({ code, message }).
async function postStream<T>(path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  const tok = tokenStore.get();
  if (tok) headers.Authorization = `Bearer ${tok}`;

  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  // Same "token was rejected" hook as request() — fires only when a token was
  // actually attached, so an unauthenticated call never trips it.
  if (res.status === 401 && tok) {
    onUnauthorized?.();
  }

  // Pre-flush HTTP error (e.g. 400 bad body, 402 insufficient balance) — no
  // stream ever opened; read the body and throw exactly like request().
  if (!res.ok || !res.body) {
    const raw = await res.text();
    const data: unknown = raw ? safeJson(raw) : undefined;
    throw errorFromBody(data, res.status);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let result: T | undefined;
  let settled = false;

  try {
    while (!settled) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      let sep: number;
      // SSE frames are separated by a blank line.
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        // Heartbeats / comments (":", ": connected") start with ':' — ignore.
        if (!frame || frame.startsWith(":")) continue;
        let event = "message";
        let data = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (event === "error") {
          let payload: { code?: string; message?: string } = {};
          try { payload = data ? JSON.parse(data) : {}; } catch { /* keep {} */ }
          // Headers were already sent as 200 before this frame, so there is no
          // real HTTP status to report — 502 is a synthetic "upstream failed".
          throw new ApiError(payload.message || "", 502, payload.code);
        }
        if (event === "done") {
          result = data ? (JSON.parse(data) as T) : undefined;
          settled = true;
          break;
        }
      }
    }
  } finally {
    try { reader.cancel(); } catch { /* noop */ }
  }

  if (result === undefined) throw new ApiError("stream ended unexpectedly", 502);
  return result;
}

export const api = {
  get:        <T,>(path: string, signal?: AbortSignal) => request<T>(path, { method: "GET", signal }),
  post:       <T,>(path: string, body?: unknown) => request<T>(path, { method: "POST", body }),
  patch:      <T,>(path: string, body?: unknown) => request<T>(path, { method: "PATCH", body }),
  delete:     <T,>(path: string) => request<T>(path, { method: "DELETE" }),
  postStream: <T,>(path: string, body?: unknown) => postStream<T>(path, body),
};
