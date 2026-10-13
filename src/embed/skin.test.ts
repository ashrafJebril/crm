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
    expect(["--ink-2", "--ink-3", "--ink-4"].every((k) => v[k] === "#999")).toBe(true);
    expect(v["--bg"]).toBeUndefined();
    expect(Object.keys(v).some((k) => k.includes("radius"))).toBe(false);
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
      "--font-sans", "--font-display",
    ]);
    expect(names.length).toBeGreaterThan(0);
    names.forEach((n) => expect(allowed.has(n)).toBe(true));
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
    expect(JSON.parse(store["aram.tweaks.v1"])).toEqual({ accent: "green", theme: "light" });
    expect(JSON.parse(store["aram.skin.v1"])).toEqual({ mode: "light", bg: "#fff" });
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
