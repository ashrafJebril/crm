import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The white-screen-after-deploy bug.
 *
 * The web image bakes `dist` into nginx, so every deploy replaces the hashed
 * chunk files. A tab opened before the deploy still holds the OLD chunk names,
 * and opening a screen it hadn't visited yet 404s. Retrying that URL can never
 * work — the file is gone — so the only cure is one full reload.
 *
 * These cover the two things that must hold: we reload for a genuinely missing
 * chunk, and we do NOT reload in a loop (or for unrelated errors, which would
 * turn an ordinary bug into an infinite refresh).
 */

const RELOAD_KEY = "kewy:chunk-reload-at";

let reload: ReturnType<typeof vi.fn>;
let store: Map<string, string>;

// The suite runs in the "node" environment (vite.config.ts) and the project
// has no jsdom. Stubbing the two globals this module touches keeps it that way
// rather than pulling a DOM implementation in for one file.
function installGlobals() {
  store = new Map();
  reload = vi.fn();
  const sessionStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
  Object.assign(globalThis, {
    sessionStorage,
    window: { location: { reload }, sessionStorage },
  });
}

beforeEach(() => {
  vi.resetModules();
  installGlobals();
});

afterEach(() => vi.restoreAllMocks());

/** Import fresh each time so the module's own state does not leak between tests. */
async function load() {
  return (await import("./lazyScreen")).lazyScreen;
}

/** React.lazy defers the loader, so reach the rejection through the payload. */
async function runLoader(lazyComponent: unknown): Promise<unknown> {
  const payload = (lazyComponent as { _payload: { _result: () => Promise<unknown> } })._payload;
  return payload._result();
}

const chunkError = () =>
  new TypeError(
    "Failed to fetch dynamically imported module: https://marketing.kewy.ai/assets/Campaigns-CXayhAXm.js",
  );

describe("lazyScreen — surviving a deploy", () => {
  it("reloads once when the chunk is gone", async () => {
    const lazyScreen = await load();
    const c = lazyScreen(() => Promise.reject(chunkError()));
    // Never resolves on purpose: the page is on its way out, and resolving
    // would flash an error before the reload lands.
    const settled = await Promise.race([
      runLoader(c).then(() => "settled").catch(() => "threw"),
      new Promise((r) => setTimeout(() => r("pending"), 20)),
    ]);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(settled).toBe("pending");
  });

  it("does not reload twice in a row — a reload loop is worse than an error", async () => {
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
    const lazyScreen = await load();
    const c = lazyScreen(() => Promise.reject(chunkError()));
    await expect(runLoader(c)).rejects.toThrow(/dynamically imported module/);
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads again once the cooldown has passed", async () => {
    sessionStorage.setItem(RELOAD_KEY, String(Date.now() - 60_000));
    const lazyScreen = await load();
    const c = lazyScreen(() => Promise.reject(chunkError()));
    await Promise.race([runLoader(c).catch(() => {}), new Promise((r) => setTimeout(r, 20))]);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("leaves an ordinary error alone", async () => {
    // Reloading on every render bug would hide real failures behind a refresh
    // loop, which is exactly the trap this guard exists to avoid.
    const lazyScreen = await load();
    const c = lazyScreen(() => Promise.reject(new Error("Cannot read properties of undefined")));
    await expect(runLoader(c)).rejects.toThrow(/Cannot read properties/);
    expect(reload).not.toHaveBeenCalled();
  });

  it("recognises the other browsers' wording", async () => {
    for (const msg of [
      "Importing a module script failed.", // Safari
      "error loading dynamically imported module", // Firefox
      "ChunkLoadError: Loading chunk 7 failed",
    ]) {
      vi.resetModules();
      installGlobals();
      const lazyScreen = await load();
      const c = lazyScreen(() => Promise.reject(new Error(msg)));
      await Promise.race([runLoader(c).catch(() => {}), new Promise((r) => setTimeout(r, 20))]);
      expect(reload, `should reload for: ${msg}`).toHaveBeenCalledTimes(1);
    }
  });

  it("passes a healthy import straight through", async () => {
    const lazyScreen = await load();
    const Comp = () => null;
    const c = lazyScreen(() => Promise.resolve({ default: Comp }));
    await expect(runLoader(c)).resolves.toMatchObject({ default: Comp });
    expect(reload).not.toHaveBeenCalled();
  });
});
