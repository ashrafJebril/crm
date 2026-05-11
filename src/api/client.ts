// Tiny typed fetch wrapper. Reads JWT from localStorage and attaches it.
// Throws ApiError on non-2xx so hooks can show error states.

const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:3001/api";
const TOKEN_KEY = "tkana.token.v1";

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
