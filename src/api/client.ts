import { PAYMENT_OVERDUE } from "@/lib/paymentLock";
import { createSseParser, STREAM_LOST, TERMINAL_EVENTS } from "./eventStream";

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
  // Parsed JSON response body (or raw text), for callers that need extra
  // fields such as a 409's `linked` counts.
  body?: unknown;
  constructor(message: string, status: number, code?: string, body?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

// In-memory copy of the session token. Inside a cross-origin iframe (Tiremall
// embed) browsers that block third-party storage (Chrome Incognito, blocked
// 3P cookies) throw on — or silently drop — localStorage access. Falling back
// to this copy keeps an embedded session alive for the life of the page.
let memoryToken: string | null = null;

export const tokenStore = {
  get(): string | null {
    let stored: string | null = null;
    try { stored = localStorage.getItem(TOKEN_KEY); } catch { /* blocked */ }
    return stored ?? memoryToken;
  },
  set(token: string): void {
    memoryToken = token;
    try { localStorage.setItem(TOKEN_KEY, token); } catch { /* ignore */ }
  },
  clear(): void {
    memoryToken = null;
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  },
};

// Global "session expired" hook. AuthProvider registers its logout() here so
// that ANY request returning 401 while a token was attached (i.e. the token
// was rejected as expired/invalid — not a login attempt) tears the session
// down and drops back to the login screen, instead of leaving every screen
// stuck in a per-request error state.
// SP-26: the handler gets the server's message key (e.g. "auth.session_expired"
// after a password reset or 2FA change ended every session).
let onUnauthorized: ((reason?: string) => void) | null = null;
export function setUnauthorizedHandler(fn: ((reason?: string) => void) | null): void {
  onUnauthorized = fn;
}

// ── SP-26 review I1/M5: who may end the session ─────────────────────────
//
// A 401 only signs the user out when the token that request carried is still
// the current one: requests already in flight with an old token (after a
// change-password or 2FA on/off issued a new one) must not sign the user out
// or clear the new token. While a session-changing call is pending, a 401 is
// held, then fired afterwards only if the token did not change.
let sessionChanges = 0;
let held: { tok: string; reason?: string } | null = null;

/** Runs a call that replaces the session token (change password, 2FA on/off). */
export async function withSessionChange<T>(fn: () => Promise<T>): Promise<T> {
  sessionChanges += 1;
  try {
    return await fn();
  } finally {
    sessionChanges -= 1;
    if (sessionChanges === 0 && held) {
      const h = held;
      held = null;
      notifyUnauthorized(h.tok, h.reason);
    }
  }
}

// Forced sign-out: every in-flight request is aborted, and error toasts are
// suppressed for a moment, so a dying session doesn't spray errors (M5).
let sessionAbort = new AbortController();
let signedOutAt = 0;
const SIGN_OUT_QUIET_MS = 3000;

/** True right after a forced sign-out: callers' error toasts stay quiet. */
export function recentlySignedOut(now = Date.now()): boolean {
  return signedOutAt > 0 && now - signedOutAt < SIGN_OUT_QUIET_MS;
}

/** A 401 for the token `tok`: signs out only if `tok` is still the session. */
export function notifyUnauthorized(tok: string, reason?: string): void {
  if (sessionChanges > 0) {
    held = { tok, reason };
    return;
  }
  if (tokenStore.get() !== tok) return; // a stale request of an older session
  signedOutAt = Date.now();
  const dying = sessionAbort;
  sessionAbort = new AbortController();
  dying.abort();
  onUnauthorized?.(reason);
}

/** The caller's signal joined with the session's: either aborts the fetch. */
function linkedSignal(signal?: AbortSignal): { signal: AbortSignal; done: () => void } {
  const ctl = new AbortController();
  const session = sessionAbort.signal;
  const abort = () => ctl.abort();
  if (signal?.aborted || session.aborted) ctl.abort();
  signal?.addEventListener("abort", abort);
  session.addEventListener("abort", abort);
  return {
    signal: ctl.signal,
    done: () => {
      signal?.removeEventListener("abort", abort);
      session.removeEventListener("abort", abort);
    },
  };
}

function unauthorizedReason(data: unknown): string | undefined {
  return isObject(data) && typeof data.message === "string" ? data.message : undefined;
}

// Global "payment overdue" hook: any 403 { code: "PAYMENT_OVERDUE" } (including
// login and the SSO exchange) lets AuthProvider swap in the lock screen.
let onPaymentOverdue: (() => void) | null = null;
export function setPaymentOverdueHandler(fn: (() => void) | null): void {
  onPaymentOverdue = fn;
}

interface RequestOpts {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  /** The caller shows a PAYMENT_OVERDUE refusal itself (e.g. a refused workspace switch); do not swap in the global lock screen. */
  localPaymentError?: boolean;
}

async function request<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  // FormData goes out as multipart: the browser must set the Content-Type (with its boundary).
  const isForm = typeof FormData !== "undefined" && opts.body instanceof FormData;
  const headers: Record<string, string> = isForm ? {} : { "Content-Type": "application/json" };
  const tok = tokenStore.get();
  if (tok) headers.Authorization = `Bearer ${tok}`;

  const link = linkedSignal(opts.signal);
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body === undefined ? undefined : isForm ? (opts.body as FormData) : JSON.stringify(opts.body),
      signal: link.signal,
    });
  } finally {
    link.done();
  }

  // A 401 on a request that DID carry a token means the session token was
  // rejected (expired/invalid). Fire the global logout hook. Login/register
  // send no token, so their "invalid credentials" 401s never reach here.
  if (res.status === 204) return undefined as T;

  const raw = await res.text();
  const data: unknown = raw ? safeJson(raw) : undefined;

  if (res.status === 401 && tok) notifyUnauthorized(tok, unauthorizedReason(data));

  if (!res.ok) throw errorFromBody(data, res.status, !opts.localPaymentError);
  return data as T;
}

// GET whose caller needs the response headers (e.g. the media library's
// `X-Media-Next-Before` cursor): same token, 401 logout and error handling as
// request(), returning the parsed body with the headers.
async function getWithHeaders<T>(path: string, signal?: AbortSignal): Promise<{ data: T; headers: Headers }> {
  const tok = tokenStore.get();
  const link = linkedSignal(signal);
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      headers: tok ? { Authorization: `Bearer ${tok}` } : {},
      signal: link.signal,
    });
  } finally {
    link.done();
  }
  const raw0 = res.status === 401 && tok ? await res.clone().text() : "";
  if (res.status === 401 && tok) notifyUnauthorized(tok, unauthorizedReason(raw0 ? safeJson(raw0) : undefined));
  const raw = await res.text();
  const data: unknown = raw ? safeJson(raw) : undefined;
  if (!res.ok) throw errorFromBody(data, res.status);
  return { data: data as T, headers: res.headers };
}

// POST with a JSON body whose successful response is a file (e.g. a CSV
// export): same token, 401 and error handling as request(), but the body is
// returned as a Blob together with the server's filename.
async function postBlob(path: string, body?: unknown): Promise<{ blob: Blob; filename: string | null }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const tok = tokenStore.get();
  if (tok) headers.Authorization = `Bearer ${tok}`;
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && tok) notifyUnauthorized(tok);
  if (!res.ok) {
    const raw = await res.text();
    throw errorFromBody(raw ? safeJson(raw) : undefined, res.status);
  }
  const cd = res.headers.get("Content-Disposition") ?? "";
  return { blob: await res.blob(), filename: /filename="?([^";]+)"?/i.exec(cd)?.[1] ?? null };
}

// GET whose successful response is a file (e.g. an .xlsx template): same
// token, 401 and error handling as request(), returned as a Blob with the
// server's filename.
async function getBlob(path: string): Promise<{ blob: Blob; filename: string | null }> {
  const headers: Record<string, string> = {};
  const tok = tokenStore.get();
  if (tok) headers.Authorization = `Bearer ${tok}`;
  const res = await fetch(`${BASE}${path}`, { method: "GET", headers });
  if (res.status === 401 && tok) notifyUnauthorized(tok);
  if (!res.ok) {
    const raw = await res.text();
    throw errorFromBody(raw ? safeJson(raw) : undefined, res.status);
  }
  const cd = res.headers.get("Content-Disposition") ?? "";
  return { blob: await res.blob(), filename: /filename="?([^";]+)"?/i.exec(cd)?.[1] ?? null };
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
function errorFromBody(data: unknown, status: number, notifyLock = true): ApiError {
  const message =
    isObject(data) && typeof data.message === "string"
      ? data.message
      : Array.isArray((data as { message?: unknown })?.message)
        ? (data as { message: string[] }).message.join(", ")
        : `HTTP ${status}`;
  const code = isObject(data) && typeof data.code === "string" ? data.code : undefined;
  if (notifyLock && status === 403 && code === PAYMENT_OVERDUE) onPaymentOverdue?.();
  return new ApiError(message, status, code, data);
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
  if (res.status === 401 && tok) notifyUnauthorized(tok);

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

export interface EventStreamOpts {
  /** Every frame as it arrives (`data` parsed as JSON when it parses, else the raw string). */
  onEvent: (event: string, data: unknown) => void;
  signal?: AbortSignal;
}

/**
 * The reading rule of `postEventStream` over already-decoded chunks: frames
 * go to `onEvent` until the first terminal event (`done` / `error`); a stream
 * that ends without one gets a synthetic `error {code: "copilot.stream_lost"}`.
 * Exported for the parser tests.
 */
export function createEventReader(onEvent: (event: string, data: unknown) => void) {
  let terminal: "done" | "error" | null = null;
  const parser = createSseParser((f) => {
    if (terminal) return;
    if (TERMINAL_EVENTS.has(f.event)) terminal = f.event as "done" | "error";
    onEvent(f.event, safeJson(f.data));
  });
  return {
    push(chunk: string) {
      if (!terminal) parser.push(chunk);
    },
    get terminal() {
      return terminal;
    },
    /** The stream ended (or was cut): returns the terminal event, delivering the synthetic error when there was none. */
    end(): "done" | "error" {
      parser.end();
      if (!terminal) {
        terminal = "error";
        onEvent("error", { code: STREAM_LOST });
      }
      return terminal;
    },
  };
}

/**
 * SP-18: POST that reads a stream of named SSE events (a copilot turn).
 * Pre-flush refusals (400/403/404/409/429/503) throw ApiError like
 * `request()`, before any event. Then each frame goes to `onEvent` as it
 * arrives; heartbeats are skipped. Every stream ends with `done` or `error`:
 * one cut early (network, server restart, abort) gets the synthetic
 * `copilot.stream_lost` error, so the caller re-reads the session (the turn
 * keeps running on the server and its answer is stored).
 */
async function postEventStream(path: string, body: unknown, opts: EventStreamOpts): Promise<"done" | "error"> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "text/event-stream" };
  const tok = tokenStore.get();
  if (tok) headers.Authorization = `Bearer ${tok}`;
  // A forced sign-out aborts the stream with every other request.
  const link = linkedSignal(opts.signal);
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body ?? {}), signal: link.signal });
  } catch (e) {
    link.done();
    throw e;
  }
  if (!res.ok || !res.body) {
    link.done();
    const raw = await res.text();
    const data = raw ? safeJson(raw) : undefined;
    // Same token-guarded session-expiry path as request(): only a 401 for the current token signs out.
    if (res.status === 401 && tok) notifyUnauthorized(tok, unauthorizedReason(data) ?? "auth.session_expired");
    throw errorFromBody(data, res.status);
  }
  const reader = createEventReader(opts.onEvent);
  const stream = res.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (!reader.terminal) {
      const chunk = await stream.read();
      if (chunk.done) break;
      reader.push(decoder.decode(chunk.value, { stream: true }));
    }
  } catch {
    /* cut: end() delivers the synthetic error */
  } finally {
    link.done();
    stream.cancel().catch(() => undefined);
  }
  return reader.end();
}

export const api = {
  get:        <T,>(path: string, signal?: AbortSignal) => request<T>(path, { method: "GET", signal }),
  getWithHeaders: <T,>(path: string, signal?: AbortSignal) => getWithHeaders<T>(path, signal),
  post:       <T,>(path: string, body?: unknown, o?: { localPaymentError?: boolean }) =>
    request<T>(path, { method: "POST", body, localPaymentError: o?.localPaymentError }),
  postForm:   <T,>(path: string, form: FormData) => request<T>(path, { method: "POST", body: form }),
  postBlob:   (path: string, body?: unknown) => postBlob(path, body),
  getBlob:    (path: string) => getBlob(path),
  patch:      <T,>(path: string, body?: unknown) => request<T>(path, { method: "PATCH", body }),
  put:        <T,>(path: string, body?: unknown) => request<T>(path, { method: "PUT", body }),
  // SP-26: DELETE …/members/:userId takes an optional `{handoverTo}` body.
  delete:     <T,>(path: string, body?: unknown) => request<T>(path, { method: "DELETE", body }),
  postStream: <T,>(path: string, body?: unknown) => postStream<T>(path, body),
  postEventStream: (path: string, body: unknown, opts: EventStreamOpts) => postEventStream(path, body, opts),
};
