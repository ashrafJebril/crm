import { describe, it, expect, vi, beforeEach } from "vitest";
import { applySkin, parseSkin, skinFromLocation, skinToCss, skinToCssVars } from "./skin";

const enc = (o: unknown) =>
  Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");

describe("parseSkin", () => {
  it("round-trips a valid payload", () => {
    const s = {
      mode: "dark", font: "Inter, 'Segoe UI'", bg: "#0a0a0c", surface: "rgb(30, 30, 38)",
      line: "#28282f", ink: "#fff", muted: "rgba(255,255,255,0.6)", accent: "#c9a55a",
      accentInk: "#000", radius: "10px",
    };
    expect(parseSkin(enc(s))).toEqual(s);
  });
  it("handles padding-less base64url", () => {
    // {"bg":"#abcd"} is 14 bytes -> base64 needs "==" padding
    const raw = enc({ bg: "#abcd" });
    expect(raw.includes("=")).toBe(false);
    expect(raw.length % 4).not.toBe(0);
    expect(parseSkin(raw)).toEqual({ bg: "#abcd" });
  });
  it("rejects injection attempts", () => {
    expect(parseSkin(enc({ font: "Inter;}body{x:y" }))).toBeNull();
    expect(parseSkin(enc({ font: "url(http://x)" }))).toBeNull();
    expect(parseSkin(enc({ bg: "red;background:url(x)" }))).toBeNull();
    expect(parseSkin(enc({ radius: "10px;" }))).toBeNull();
    expect(parseSkin(enc({ mode: "dark;", ink: "#fff" }))).toEqual({ ink: "#fff" });
  });
  it("drops unknown keys", () => {
    expect(parseSkin(enc({ bg: "#fff", evil: "#000" }))).toEqual({ bg: "#fff" });
  });
  it("returns null for garbage", () => {
    expect(parseSkin(null)).toBeNull();
    expect(parseSkin("")).toBeNull();
    expect(parseSkin("!!!notbase64")).toBeNull();
    expect(parseSkin(enc("not json"))).toBeNull();
    expect(parseSkin(enc("[1,2]"))).toBeNull();
    expect(parseSkin(enc({}))).toBeNull();
  });
});

describe("skinToCssVars", () => {
  it("maps keys and omits absent ones", () => {
    expect(skinToCssVars({ bg: "#111" })).toEqual({ "--bg": "#111", "--bg-1": "#111" });
    const v = skinToCssVars({ accent: "#c9a55a", font: "Inter", muted: "#999", radius: "8px" });
    expect(v["--accent"]).toBe("#c9a55a");
    expect(v["--accent-soft"]).toBe("color-mix(in srgb, #c9a55a 14%, transparent)");
    expect(v["--accent-ring"]).toBe("color-mix(in srgb, #c9a55a 35%, transparent)");
    expect(v["--font-sans"]).toBe("Inter");
    expect(v["--font-display"]).toBe("Inter");
    expect(v["--ink-2"]).toBe("#999");
    expect(v["--ink-3"]).toBe("color-mix(in srgb, #999 80%, transparent)");
    expect(v["--ink-4"]).toBe("color-mix(in srgb, #999 60%, transparent)");
    expect(v["--r"]).toBe("8px");
    expect(v["--r-md"]).toBe("8px");
    expect(v["--r-xl"]).toBe("calc(8px * 2.5)");
    expect(v["--bubble-out"]).toBe("color-mix(in srgb, #c9a55a 18%, transparent)");
    expect(v["--bubble-out-line"]).toBe("color-mix(in srgb, #c9a55a 45%, transparent)");
    expect(v["--bg"]).toBeUndefined();
  });
  it("css text only uses allowlisted var names", () => {
    const css = skinToCss({
      mode: "dark", bg: "#111", surface: "#222", line: "#333", ink: "#fff", muted: "#999",
      accent: "#c9a55a", accentInk: "#000", font: "Inter", radius: "8px",
    });
    const names = [...css.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]);
    const allowed = new Set([
      "--bg", "--bg-1", "--bg-2", "--bg-3", "--bg-elev", "--line", "--line-soft", "--ink", "--ink-1",
      "--ink-2", "--ink-3", "--ink-4", "--accent", "--accent-soft", "--accent-ring", "--accent-ink",
      "--font-sans", "--font-display", "--bubble-out", "--bubble-out-line", "--bubble-out-ink", "--ix-green-strong",
      "--r", "--r-xs", "--r-sm", "--r-md", "--r-lg", "--r-xl",
    ]);
    expect(names.length).toBeGreaterThan(0);
    names.forEach((n) => expect(allowed.has(n)).toBe(true));
    expect(css).toContain(':root[data-embed="1"][data-theme] .inbox-v2');
    expect(css).toContain(".ix-display { font-family: var(--font-display); }");
    expect(css).toContain("--r-md: 8px;");
    expect(css).toContain("--bubble-out: #c9a55a;");
    expect(css).toContain("--bubble-out-ink: #000;");
    expect(css.startsWith(':root[data-embed="1"], :root[data-embed="1"][data-theme]')).toBe(true);
  });
});

describe("applySkin", () => {
  beforeEach(() => vi.unstubAllGlobals());
  it("replaces an existing style tag and sets data-theme", () => {
    const attrs: Record<string, string> = {};
    const appended: { id: string; textContent: string | null }[] = [];
    const removed = vi.fn();
    const doc = {
      getElementById: vi.fn(() => ({ remove: removed })),
      createElement: vi.fn(() => ({ id: "", textContent: null as string | null })),
      head: { appendChild: (n: never) => appended.push(n) },
      documentElement: { setAttribute: (k: string, v: string) => { attrs[k] = v; } },
    };
    const store: Record<string, string> = { "aram.tweaks.v1": JSON.stringify({ accent: "green" }) };
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
    });
    vi.stubGlobal("sessionStorage", { setItem: (k: string, v: string) => { store[k] = v; } });
    applySkin({ mode: "light", bg: "#fff" }, doc);
    expect(removed).toHaveBeenCalledTimes(1);
    expect(appended).toHaveLength(1);
    expect(appended[0].id).toBe("host-skin");
    expect(appended[0].textContent).toContain("--bg: #fff;");
    expect(attrs["data-theme"]).toBe("light");
    expect(JSON.parse(store["aram.tweaks.v1"])).toEqual({ accent: "green" });
    expect(JSON.parse(store["aram.skin.v1"])).toEqual({ mode: "light", bg: "#fff" });
  });
});

describe("validation tightening", () => {
  it("rejects malformed colors and odd quotes", () => {
    expect(parseSkin(enc({ bg: "#12345" }))).toBeNull();
    expect(parseSkin(enc({ bg: "rgb(1,2)" }))).toBeNull();
    expect(parseSkin(enc({ bg: "rgb(1 2 3 4)" }))).toBeNull();
    expect(parseSkin(enc({ bg: "rgba(1, 2, 3, 0.5)" }))).toEqual({ bg: "rgba(1, 2, 3, 0.5)" });
    expect(parseSkin(enc({ font: "Inter, 'Segoe" }))).toBeNull();
    expect(parseSkin(enc({ font: 'Inter, "Segoe' }))).toBeNull();
  });
  it("keeps every key of the admin's ADMIN_SKIN", () => {
    const admin = {
      mode: "light", font: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      bg: "#f8fafc", surface: "#ffffff", line: "#e2e8f0", ink: "#0f172a", muted: "#64748b",
      accent: "#3b82f6", accentInk: "#ffffff", radius: "10px",
    };
    expect(parseSkin(enc(admin))).toEqual(admin);
  });
});

describe("skinFromLocation", () => {
  const hash = `#tmsso=abc&skin=${enc({ bg: "#fff" })}`;
  it("ignores skin when not embedded", () => {
    expect(skinFromLocation({ hash }, false)).toBeNull();
  });
  it("reads skin when embedded", () => {
    expect(skinFromLocation({ hash }, true)).toEqual({ bg: "#fff" });
    expect(skinFromLocation({ hash: "" }, true)).toBeNull();
  });
});
