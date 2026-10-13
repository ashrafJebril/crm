import { describe, it, expect, vi } from "vitest";
import { consumeEmbedFragment, type FragmentDeps } from "./fragment";

const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const framedWin = { parent: {} } as unknown as Window;
const topWin = {} as Window;
(topWin as unknown as { parent: Window }).parent = topWin;

function deps(stored: unknown = null) {
  return {
    markEmbedded: vi.fn(),
    notifyOpenerConnected: vi.fn(() => false),
    setToken: vi.fn(),
    clearToken: vi.fn(),
    applySkin: vi.fn(),
    storedSkin: vi.fn(() => stored),
    mergeTheme: vi.fn(),
    replaceState: vi.fn(),
  } as unknown as FragmentDeps & Record<string, ReturnType<typeof vi.fn>>;
}
const loc = (search: string, hash: string) => ({ pathname: "/", search, hash });
const skinHash = (extra = "") => `#${extra}skin=${enc({ bg: "#fff" })}`;

describe("consumeEmbedFragment", () => {
  it("applies the skin and scrubs when only skin is present", () => {
    const d = deps();
    consumeEmbedFragment(loc("?embed=1", skinHash()), framedWin, d);
    expect(d.applySkin).toHaveBeenCalledWith({ bg: "#fff" });
    expect(d.replaceState).toHaveBeenCalledWith("/?embed=1");
  });
  it("tmsso flow still works alongside skin", () => {
    const d = deps();
    const r = consumeEmbedFragment(loc("?embed=1", skinHash("tmsso=abc&")), framedWin, d);
    expect(r.pendingTiremallSso).toBe("abc");
    expect(d.applySkin).toHaveBeenCalled();
    expect(d.clearToken).toHaveBeenCalled();
    expect(d.replaceState).toHaveBeenCalledTimes(1);
  });
  it("falls back to the stored skin on reload", () => {
    const d = deps({ bg: "#000" });
    consumeEmbedFragment(loc("?embed=1", ""), framedWin, d);
    expect(d.applySkin).toHaveBeenCalledWith({ bg: "#000" });
  });
  it("an invalid in-hash skin does not fall back to the stored one", () => {
    const d = deps({ bg: "#000" });
    consumeEmbedFragment(loc("?embed=1", "#skin=!!!"), framedWin, d);
    expect(d.applySkin).not.toHaveBeenCalled();
    expect(d.replaceState).toHaveBeenCalled();
  });
  it("hjz #token path ignores skin", () => {
    const d = deps();
    consumeEmbedFragment(loc("", `#token=t1&theme=dark&skin=${enc({ bg: "#fff" })}`), topWin, d);
    expect(d.applySkin).not.toHaveBeenCalled();
    expect(d.setToken).toHaveBeenCalledWith("t1");
    expect(d.mergeTheme).toHaveBeenCalledWith("dark");
    expect(d.replaceState).toHaveBeenCalledWith("/");
  });
  it("top-level (not framed) ?embed=1 ignores skin and stored skin", () => {
    const d = deps({ bg: "#000" });
    consumeEmbedFragment(loc("?embed=1", skinHash()), topWin, d);
    expect(d.applySkin).not.toHaveBeenCalled();
    expect(d.pendingTiremallSso).toBeUndefined();
  });
  it("non-embed load ignores skin", () => {
    const d = deps({ bg: "#000" });
    consumeEmbedFragment(loc("", skinHash()), framedWin, d);
    expect(d.applySkin).not.toHaveBeenCalled();
    expect(d.markEmbedded).not.toHaveBeenCalled();
  });
});
