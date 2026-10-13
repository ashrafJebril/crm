import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Fresh module per test so the in-memory token copy does not leak between cases.
async function loadStore() {
  vi.resetModules();
  return (await import("./client")).tokenStore;
}

afterEach(() => vi.unstubAllGlobals());

describe("tokenStore with blocked third-party storage", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("SecurityError"); },
      setItem: () => { throw new Error("SecurityError"); },
      removeItem: () => { throw new Error("SecurityError"); },
    });
  });

  it("keeps the token in memory when localStorage throws", async () => {
    const store = await loadStore();
    store.set("tok-1");
    expect(store.get()).toBe("tok-1");
  });

  it("clear() drops the in-memory copy", async () => {
    const store = await loadStore();
    store.set("tok-1");
    store.clear();
    expect(store.get()).toBeNull();
  });
});

describe("tokenStore when localStorage silently drops writes", () => {
  it("falls back to memory when getItem returns nothing", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    });
    const store = await loadStore();
    store.set("tok-2");
    expect(store.get()).toBe("tok-2");
  });
});

describe("tokenStore with working localStorage", () => {
  it("prefers the persisted value", async () => {
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    });
    const store = await loadStore();
    store.set("tok-3");
    expect(data.get("aram.token.v1")).toBe("tok-3");
    expect(store.get()).toBe("tok-3");
    store.clear();
    expect(store.get()).toBeNull();
    expect(data.has("aram.token.v1")).toBe(false);
  });

  it("returns null when nothing is stored", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    const store = await loadStore();
    expect(store.get()).toBeNull();
  });
});
