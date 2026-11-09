import * as vm from "node:vm";
import { WIDGET_JS } from "./widget.js";
import { CHAT_PAGE_JS } from "./chat-page.js";

/* A minimal DOM double, just enough to run the two vanilla scripts. */
/* eslint-disable @typescript-eslint/no-explicit-any */
class El {
  tagName: string;
  attrs: Record<string, string> = {};
  children: El[] = [];
  listeners: Record<string, ((e: any) => unknown)[]> = {};
  styles: Record<string, string> = {};
  style: any;
  textContent = "";
  hidden = false;
  disabled = false;
  value = "";
  className = "";
  type = "";
  src = "";
  title = "";
  scrollTop = 0;
  scrollHeight = 0;
  dataset: Record<string, string> = {};
  contentWindow: any = {};
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(tag: string) {
    this.tagName = tag;
    const styles = this.styles;
    this.style = new Proxy(
      { setProperty: (k: string, v: string) => (styles[k] = v) },
      { set: (t, k, v) => ((styles[String(k)] = v), true), get: (t: any, k) => (k in t ? t[k] : styles[String(k)]) },
    );
  }
  get firstChild() {
    return this.children[0] ?? null;
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = String(v);
  }
  getAttribute(k: string) {
    return this.attrs[k] ?? null;
  }
  appendChild(c: El) {
    this.children.push(c);
    return c;
  }
  replaceChild(n: El, o: El) {
    const i = this.children.indexOf(o);
    if (i >= 0) this.children[i] = n;
    return o;
  }
  addEventListener(t: string, fn: (e: any) => unknown) {
    (this.listeners[t] ??= []).push(fn);
  }
  async fire(t: string, e: any = {}) {
    for (const fn of this.listeners[t] ?? []) await fn({ preventDefault() {}, ...e });
  }
  focus() {}
}

function loaderEnv(attrs: Record<string, string>, opts: { dir?: string } = {}) {
  const body = new El("body");
  const listeners: ((e: any) => void)[] = [];
  const doc: any = {
    currentScript: { src: "https://api.example.com/api/widget.js?v=1", getAttribute: (k: string) => attrs[k] ?? null },
    documentElement: { dir: opts.dir ?? "", lang: "en" },
    body,
    createElement: (t: string) => new El(t),
    createElementNS: (_ns: string, t: string) => new El(t),
    addEventListener: () => {},
  };
  const sandbox: any = {
    document: doc,
    location: { origin: "https://shop.example" },
    navigator: { language: "en-US" },
    getComputedStyle: () => ({ direction: opts.dir ?? "ltr" }),
    URL,
    encodeURIComponent,
    addEventListener: (t: string, fn: (e: any) => void) => t === "message" && listeners.push(fn),
  };
  sandbox.window = sandbox;
  vm.runInNewContext(WIDGET_JS, sandbox);
  const button = body.children[0];
  const iframe = () => body.children.find((c) => c.tagName === "iframe");
  return { sandbox, body, button, iframe, post: (e: any) => listeners.forEach((fn) => fn(e)) };
}

describe("widget.js loader", () => {
  it("mounts one bubble at the inline end and lazily creates the iframe on click", async () => {
    const env = loaderEnv({ "data-channel": "W1" });
    expect(env.body.children).toHaveLength(1);
    expect(env.button.styles.right).toBe("20px");
    expect(env.button.styles.background).toBe("#111827");
    expect(env.iframe()).toBeUndefined();
    await env.button.fire("click");
    const f = env.iframe()!;
    expect(f.src).toBe("https://api.example.com/api/chat/W1?embed=1&parent=https%3A%2F%2Fshop.example");
    expect(f.styles.display).toBe("block");
    expect(env.button.getAttribute("aria-expanded")).toBe("true");
    await env.button.fire("click");
    expect(f.styles.display).toBe("none");
  });

  it("Arabic / RTL: the end side is the left, lang passes through, labels are Arabic", async () => {
    const env = loaderEnv({ "data-channel": "W1", "data-lang": "ar", "data-color": "#0f766e" });
    expect(env.button.styles.left).toBe("20px");
    expect(env.button.styles.background).toBe("#0f766e");
    expect(env.button.getAttribute("aria-label")).toBe("افتح المحادثة");
    await env.button.fire("click");
    expect(env.iframe()!.src).toContain("&lang=ar");
    const rtlPage = loaderEnv({ "data-channel": "W1", "data-position": "start" }, { dir: "rtl" });
    expect(rtlPage.button.styles.right).toBe("20px");
  });

  it("ignores a bad channel id or colour and only obeys close messages from its own frame and the API origin", async () => {
    expect(loaderEnv({ "data-channel": "W1\"><script>" }).body.children).toHaveLength(0);
    expect(loaderEnv({ "data-channel": "W1", "data-color": "red;background:url(x)" }).button.styles.background).toBe("#111827");
    const env = loaderEnv({ "data-channel": "W1" });
    await env.button.fire("click");
    const f = env.iframe()!;
    env.post({ source: {}, origin: "https://api.example.com", data: { type: "tk-widget:close" } });
    env.post({ source: f.contentWindow, origin: "https://evil.example", data: { type: "tk-widget:close" } });
    expect(f.styles.display).toBe("block");
    env.post({ source: f.contentWindow, origin: "https://api.example.com", data: { type: "tk-widget:close" } });
    expect(f.styles.display).toBe("none");
  });
});

function pageEnv(opts: { storage: "ok" | "blocked"; config?: any; posts?: any[] }) {
  const ids = ["wc-log", "wc-form", "wc-input", "wc-name", "wc-status", "wc-send", "wc-close"];
  const els: Record<string, El> = Object.fromEntries(ids.map((i) => [i, new El(i)]));
  els["wc-name"].hidden = true;
  els["wc-close"].hidden = true;
  const head = new El("head");
  const body = new El("body");
  body.dataset = { channel: "W1", lang: "en", embed: "0", parent: "", api: "/api" };
  const store = new Map<string, string>();
  const localStorage =
    opts.storage === "ok"
      ? { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) }
      : {
          getItem: () => {
            throw new Error("SecurityError");
          },
          setItem: () => {
            throw new Error("SecurityError");
          },
          removeItem: () => {
            throw new Error("SecurityError");
          },
        };
  const posts = [...(opts.posts ?? [])];
  const calls: { url: string; init: any }[] = [];
  const fetch = jest.fn(async (url: string, init: any = {}) => {
    calls.push({ url, init });
    let status = 200;
    let json: any = {};
    if (url.includes("/config")) json = opts.config ?? { displayName: "Shop", greeting: "<img src=x onerror=alert(1)>", askName: true, color: "#0f766e" };
    else if (init.method === "POST") json = posts.shift();
    else json = { items: [] };
    if (json && json.__status) status = json.__status;
    return { ok: status < 400, status, json: async () => json };
  });
  const intervals: unknown[] = [];
  const docEl = { style: { setProperty: jest.fn() } };
  const sandbox: any = {
    document: { body, head, documentElement: docEl, getElementById: (i: string) => els[i], createElement: (t: string) => new El(t) },
    localStorage,
    fetch,
    setInterval: (fn: unknown) => (intervals.push(fn), intervals.length),
    clearInterval: () => {},
    JSON,
    Object,
    Array,
    String,
    encodeURIComponent,
  };
  sandbox.window = sandbox;
  sandbox.parent = sandbox;
  vm.runInNewContext(CHAT_PAGE_JS, sandbox);
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { els, head, calls, store, flush, intervals, docEl };
}

describe("chat-page.js client", () => {
  const visitor = { visitorId: "V".repeat(22), visitorToken: "T".repeat(43) };

  it("renders untrusted text with textContent only, applies the colour and shows the name field", async () => {
    const env = pageEnv({ storage: "ok" });
    await env.flush();
    const greeting = env.els["wc-log"].children[0].children[0];
    expect(greeting.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(greeting.attrs.dir).toBe("auto");
    expect(env.els["wc-name"].hidden).toBe(false);
    expect(env.docEl.style.setProperty).toHaveBeenCalledWith("--wc", "#0f766e");
    expect(env.calls[0].url).toBe("/api/widget/W1/config");
  });

  it("first send mints the visitor (stored), then uses it; the socket script is loaded with polling as fallback", async () => {
    const env = pageEnv({
      storage: "ok",
      posts: [
        { ...visitor, message: { id: "m1", from: "visitor", body: "hello", at: "2026-11-09T10:00:00.000Z" } },
        { ...visitor, message: { id: "m2", from: "visitor", body: "again", at: "2026-11-09T10:00:01.000Z" } },
      ],
    });
    await env.flush();
    env.els["wc-input"].value = " hello ";
    env.els["wc-name"].value = "Sara";
    await env.els["wc-form"].fire("submit");
    const first = JSON.parse(env.calls[1].init.body);
    expect(first).toEqual({ body: "hello", name: "Sara" });
    expect(JSON.parse(env.store.get("tkw:W1")!)).toEqual(visitor);
    const script = env.head.children[0];
    expect(script.src).toBe("/api/socket.io/socket.io.js");
    script.onerror!();
    expect(env.intervals).toHaveLength(1);

    env.els["wc-input"].value = "again";
    await env.els["wc-form"].fire("submit");
    expect(JSON.parse(env.calls[2].init.body)).toEqual({ body: "again", ...visitor });
    expect(env.els["wc-log"].children.map((r) => r.children[0].textContent)).toEqual(["<img src=x onerror=alert(1)>", "hello", "again"]);
  });

  it("blocked localStorage falls back to memory for the session", async () => {
    const env = pageEnv({
      storage: "blocked",
      posts: [
        { ...visitor, message: { id: "m1", from: "visitor", body: "a", at: "2026-11-09T10:00:00.000Z" } },
        { ...visitor, message: { id: "m2", from: "visitor", body: "b", at: "2026-11-09T10:00:01.000Z" } },
      ],
    });
    await env.flush();
    env.els["wc-input"].value = "a";
    await env.els["wc-form"].fire("submit");
    env.els["wc-input"].value = "b";
    await env.els["wc-form"].fire("submit");
    expect(JSON.parse(env.calls[2].init.body)).toMatchObject(visitor);
  });

  it("shows a localized error for 429 and an unavailable channel", async () => {
    const env = pageEnv({ storage: "ok", posts: [{ __status: 429, message: "widget.rate_limited" }] });
    await env.flush();
    env.els["wc-input"].value = "x";
    await env.els["wc-form"].fire("submit");
    expect(env.els["wc-status"].textContent).toBe("Too many messages. Please wait a moment.");
    const gone = pageEnv({ storage: "ok", config: { __status: 404 } });
    await gone.flush();
    expect(gone.els["wc-status"].textContent).toBe("This chat is not available.");
    expect(gone.els["wc-input"].disabled).toBe(true);
  });
});
