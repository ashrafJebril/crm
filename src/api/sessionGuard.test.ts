import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SP-26 review I1/M5: a 401 signs out only when the request's token is still
 * the session's; session-changing calls hold 401s; a forced sign-out aborts
 * in-flight requests and quiets error toasts.
 */
type Client = typeof import("./client");

async function load(): Promise<Client> {
  vi.resetModules();
  return import("./client");
}

const res401 = (message = "Unauthorized") =>
  new Response(JSON.stringify({ statusCode: 401, message }), { status: 401, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  const mem = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("401 handling across a token change", () => {
  it("a 401 for the current token signs out with the server's reason", async () => {
    const c = await load();
    c.tokenStore.set("tok-A");
    const handler = vi.fn();
    c.setUnauthorizedHandler(handler);
    vi.stubGlobal("fetch", vi.fn(async () => res401("auth.session_expired")));
    await expect(c.api.get("/x")).rejects.toMatchObject({ status: 401 });
    expect(handler).toHaveBeenCalledWith("auth.session_expired");
  });

  it("a late 401 of a request sent with the old token never signs out (or clears the new token)", async () => {
    const c = await load();
    c.tokenStore.set("tok-old");
    const handler = vi.fn();
    c.setUnauthorizedHandler(handler);
    let release!: (r: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((r) => (release = r))));
    const inFlight = c.api.get("/slow");
    // Meanwhile the user changed the password and adopted the new token.
    c.tokenStore.set("tok-new");
    release(res401("auth.session_expired"));
    await expect(inFlight).rejects.toMatchObject({ status: 401 });
    expect(handler).not.toHaveBeenCalled();
    expect(c.tokenStore.get()).toBe("tok-new");
  });

  it("401s during a session-changing call are held, then dropped when the token changed", async () => {
    const c = await load();
    c.tokenStore.set("tok-old");
    const handler = vi.fn();
    c.setUnauthorizedHandler(handler);
    vi.stubGlobal("fetch", vi.fn(async () => res401("auth.session_expired")));
    await c.withSessionChange(async () => {
      await expect(c.api.get("/other")).rejects.toMatchObject({ status: 401 });
      expect(handler).not.toHaveBeenCalled();
      c.tokenStore.set("tok-new");
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("a held 401 still signs out when the session-changing call failed (token unchanged)", async () => {
    const c = await load();
    c.tokenStore.set("tok-old");
    const handler = vi.fn();
    c.setUnauthorizedHandler(handler);
    vi.stubGlobal("fetch", vi.fn(async () => res401("auth.session_expired")));
    await expect(
      c.withSessionChange(async () => {
        await c.api.get("/other").catch(() => undefined);
        throw new Error("change failed");
      }),
    ).rejects.toThrow("change failed");
    expect(handler).toHaveBeenCalledWith("auth.session_expired");
  });
});

describe("forced sign-out", () => {
  it("aborts the other in-flight requests and quiets error toasts for a moment", async () => {
    const c = await load();
    c.tokenStore.set("tok-A");
    c.setUnauthorizedHandler(() => c.tokenStore.clear());
    const pending: { signal?: AbortSignal; reject: (e: unknown) => void }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init: RequestInit) => {
        if (url.endsWith("/dies")) return Promise.resolve(res401());
        return new Promise<Response>((_r, reject) => {
          const signal = init.signal ?? undefined;
          pending.push({ signal, reject });
          signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        });
      }),
    );
    const other = c.api.get("/slow");
    expect(c.recentlySignedOut()).toBe(false);
    await expect(c.api.get("/dies")).rejects.toMatchObject({ status: 401 });
    await expect(other).rejects.toMatchObject({ name: "AbortError" });
    expect(pending[0].signal?.aborted).toBe(true);
    expect(c.recentlySignedOut()).toBe(true);
    expect(c.recentlySignedOut(Date.now() + 5000)).toBe(false);
  });

  it("a caller's own abort still works, and new requests after sign-out are not pre-aborted", async () => {
    const c = await load();
    c.tokenStore.set("tok-A");
    c.setUnauthorizedHandler(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init: RequestInit) =>
        url.endsWith("/dies")
          ? Promise.resolve(res401())
          : init.signal?.aborted
            ? Promise.reject(new DOMException("Aborted", "AbortError"))
            : Promise.resolve(new Response("{}", { status: 200 })),
      ),
    );
    await c.api.get("/dies").catch(() => undefined);
    await expect(c.api.get("/fresh")).resolves.toEqual({});
    const ac = new AbortController();
    ac.abort();
    await expect(c.api.get("/mine", ac.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
