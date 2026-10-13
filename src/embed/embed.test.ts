import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allowedParentOrigins, authScreen, isAllowedParent, isEmbedded, markEmbedded, notifyOpenerConnected, parseInbound, postToParent } from "./embed";

const parent = {};
const A = ["https://a.com"];

beforeEach(() => {
  vi.stubGlobal("window", { parent, location: { origin: "https://crm.example" } });
});
afterEach(() => vi.unstubAllGlobals());

const ev = (o: Partial<{ origin: string; source: unknown; data: unknown }>) =>
  ({ origin: "https://a.com", source: parent, data: {}, ...o }) as unknown as MessageEvent;

describe("allowedParentOrigins", () => {
  it("splits, trims, drops empties", () => {
    expect(allowedParentOrigins("https://a.com, http://localhost:5173 ,")).toEqual([
      "https://a.com",
      "http://localhost:5173",
    ]);
  });
  it("empty/undefined -> []", () => {
    expect(allowedParentOrigins("")).toEqual([]);
    expect(allowedParentOrigins(undefined)).toEqual([]);
  });
});

describe("isAllowedParent", () => {
  it("exact match only", () => {
    expect(isAllowedParent("https://a.com", A)).toBe(true);
    expect(isAllowedParent("https://evil.com", A)).toBe(false);
    expect(isAllowedParent("https://a.com.evil.com", A)).toBe(false);
  });
});

describe("parseInbound", () => {
  it("accepts navigate from allowed parent", () => {
    expect(parseInbound(ev({ data: { type: "kewy:navigate", route: "inbox" } }), A)).toEqual({
      type: "kewy:navigate",
      route: "inbox",
    });
  });
  it("rejects disallowed origin", () => {
    expect(parseInbound(ev({ origin: "https://evil.com", data: { type: "kewy:navigate", route: "inbox" } }), A)).toBeNull();
  });
  it("rejects wrong source", () => {
    expect(parseInbound(ev({ source: {}, data: { type: "kewy:navigate", route: "inbox" } }), A)).toBeNull();
  });
  it("rejects unknown type and non-string route", () => {
    expect(parseInbound(ev({ data: { type: "x", route: "inbox" } }), A)).toBeNull();
    expect(parseInbound(ev({ data: { type: "kewy:navigate", route: 3 } }), A)).toBeNull();
    expect(parseInbound(ev({ data: null }), A)).toBeNull();
  });
  it("connected only from same origin", () => {
    const data = { type: "kewy:connected", provider: "instagram" };
    expect(parseInbound(ev({ origin: "https://crm.example", source: {}, data }), A)).toEqual(data);
    expect(parseInbound(ev({ origin: "https://a.com", data }), A)).toBeNull();
  });
});

describe("authScreen", () => {
  it("embedded+anonymous never yields login", () => {
    expect(authScreen("anonymous", true)).toBe("embed-failed");
    expect(authScreen("anonymous", false)).toBe("login");
    expect(authScreen("loading", true)).toBe("loading");
    expect(authScreen("loading", false)).toBe("loading");
    expect(authScreen("authenticated", true)).toBe("app");
    expect(authScreen("authenticated", false)).toBe("app");
  });
});

describe("isEmbedded", () => {
  it("stays true after markEmbedded even if sessionStorage throws", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    });
    markEmbedded();
    expect(isEmbedded()).toBe(true);
  });
});

describe("postToParent", () => {
  const post = vi.fn();
  const setup = (o: { parent?: unknown; ancestor?: string; referrer?: string; env?: string }) => {
    const par = o.parent ?? { postMessage: post };
    const win: Record<string, unknown> = {
      parent: par,
      location: { origin: "https://crm.example", ancestorOrigins: o.ancestor ? [o.ancestor] : undefined },
    };
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", { referrer: o.referrer ?? "", documentElement: { dataset: {} } });
    vi.stubGlobal("sessionStorage", { getItem: () => "1", setItem: () => {} });
    vi.stubEnv("VITE_EMBED_PARENT_ORIGINS", o.env ?? "https://a.com,https://b.com");
    return win;
  };
  beforeEach(() => post.mockClear());
  afterEach(() => vi.unstubAllEnvs());

  it("no call when not embedded", async () => {
    setup({});
    vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: () => {} });
    vi.resetModules();
    const fresh = await import("./embed");
    expect(fresh.isEmbedded()).toBe(false);
    fresh.postToParent({ type: "kewy:ready" });
    expect(post).not.toHaveBeenCalled();
  });
  it("no call when not framed", () => {
    const win = setup({});
    win.parent = win;
    postToParent({ type: "kewy:ready" });
    expect(post).not.toHaveBeenCalled();
  });
  it("no call when no allowed origins", () => {
    setup({ env: "" });
    postToParent({ type: "kewy:ready" });
    expect(post).not.toHaveBeenCalled();
  });
  it("prefers ancestorOrigins, then referrer, then first allowed; never *", () => {
    setup({ ancestor: "https://b.com", referrer: "https://a.com/x" });
    postToParent({ type: "kewy:ready" });
    expect(post).toHaveBeenLastCalledWith({ type: "kewy:ready" }, "https://b.com");
    setup({ ancestor: "https://evil.com", referrer: "https://b.com/x" });
    postToParent({ type: "kewy:ready" });
    expect(post).toHaveBeenLastCalledWith({ type: "kewy:ready" }, "https://b.com");
    setup({ ancestor: "https://evil.com", referrer: "https://evil2.com/x" });
    postToParent({ type: "kewy:ready" });
    expect(post).toHaveBeenLastCalledWith({ type: "kewy:ready" }, "https://a.com");
    for (const c of post.mock.calls) expect(c[1]).not.toBe("*");
  });
});

describe("connect popup (embedded)", () => {
  const setup = async (open: unknown) => {
    vi.resetModules();
    vi.stubGlobal("window", { parent, location: { origin: "https://crm.example", href: "" }, open });
    vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: () => {} });
    const m = await import("./embed");
    m.markEmbedded();
    return m;
  };

  it("opens the popup synchronously, before the fetch resolves", async () => {
    const open = vi.fn(() => ({}));
    const m = await setup(open);
    const order: string[] = [];
    let resolveFetch!: (u: string) => void;
    const fetchP = new Promise<string>((r) => (resolveFetch = r));
    const run = (async () => {
      const h = m.beginConnectWindow();
      order.push("opened");
      await fetchP;
      order.push("fetched");
      return h;
    })();
    expect(open).toHaveBeenCalledWith("about:blank", "kewy-connect", "width=600,height=750");
    expect(order).toEqual(["opened"]);
    resolveFetch("x");
    await run;
    expect(order).toEqual(["opened", "fetched"]);
  });

  it("null handle: no top navigation", async () => {
    const m = await setup(vi.fn(() => null));
    expect(m.beginConnectWindow()).toBeNull();
    expect((window as unknown as { location: { href: string } }).location.href).toBe("");
  });

  it("navigate sets the handle location; abort closes it", async () => {
    const m = await setup(vi.fn());
    const h = { location: { href: "" }, close: vi.fn() } as unknown as Window;
    m.navigateConnectWindow(h, "https://p.example/auth");
    expect(h.location.href).toBe("https://p.example/auth");
    m.abortConnectWindow(h);
    expect(h.close).toHaveBeenCalled();
  });

  it("closed-poll fires onClosed exactly once", async () => {
    vi.useFakeTimers();
    try {
      const m = await setup(vi.fn());
      const h = { closed: false } as unknown as { closed: boolean };
      const onClosed = vi.fn();
      m.watchConnectWindow(h as unknown as Window, onClosed);
      vi.advanceTimersByTime(3000);
      expect(onClosed).not.toHaveBeenCalled();
      h.closed = true;
      vi.advanceTimersByTime(5000);
      expect(onClosed).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("poll gives up after maxMs", async () => {
    vi.useFakeTimers();
    try {
      const m = await setup(vi.fn());
      const onClosed = vi.fn();
      const h = { closed: false } as unknown as Window;
      m.watchConnectWindow(h, onClosed, 1000, 5000);
      vi.advanceTimersByTime(6000);
      (h as unknown as { closed: boolean }).closed = true;
      vi.advanceTimersByTime(5000);
      expect(onClosed).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("connectCallbackProvider", () => {
  it("recognizes fb and zernio callbacks only", async () => {
    const { connectCallbackProvider: f } = await import("./embed");
    expect(f({ search: "?fb=connected", hash: "" })).toBe("facebook");
    expect(f({ search: "", hash: "#/settings?zernio=connected&platform=facebook" })).toBe("zernio");
    expect(f({ search: "", hash: "#settings?zernio=connected" })).toBe("zernio");
    expect(f({ search: "?fb=error", hash: "" })).toBeNull();
    expect(f({ search: "", hash: "#/dashboard?zernio=connected" })).toBeNull();
    expect(f({ search: "", hash: "#/settings" })).toBeNull();
    expect(f({ search: "?embed=1", hash: "" })).toBeNull();
  });
});

describe("notifyOpenerConnected", () => {
  it("posts to opener and closes in the connect popup", () => {
    const postMessage = vi.fn();
    const close = vi.fn();
    vi.stubGlobal("window", { name: "kewy-connect", opener: { postMessage }, close, location: { origin: "https://crm.example" } });
    expect(notifyOpenerConnected("zernio")).toBe(true);
    expect(postMessage).toHaveBeenCalledWith({ type: "kewy:connected", provider: "zernio" }, "https://crm.example");
    expect(close).toHaveBeenCalled();
  });
  it("does nothing without opener or wrong window name", () => {
    vi.stubGlobal("window", { name: "", opener: null, close: vi.fn(), location: { origin: "x" } });
    expect(notifyOpenerConnected("zernio")).toBe(false);
  });
});
