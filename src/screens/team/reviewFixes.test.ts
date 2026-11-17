import { describe, expect, it, vi } from "vitest";
import { copyText } from "@/lib/copyText";
import { captureTokenLink, pageForHash } from "@/auth/publicPageStore";
import { memberActions } from "./memberActions";

const TOKEN = "A".repeat(43);

describe("member actions are hidden while impersonating (M1)", () => {
  const all = () => true;
  it("remove and 2FA reset never show while impersonating; handover still does", () => {
    expect(memberActions({ self: false, twoFA: true, impersonating: false, can: all })).toEqual(["handover", "reset2fa", "remove"]);
    expect(memberActions({ self: false, twoFA: true, impersonating: true, can: all })).toEqual(["handover"]);
    expect(memberActions({ self: true, twoFA: true, impersonating: false, can: all })).toEqual([]);
    expect(memberActions({ self: false, twoFA: false, impersonating: false, can: all })).toEqual(["handover", "remove"]);
    expect(memberActions({ self: false, twoFA: true, impersonating: false, can: (p) => p === "members.delete" })).toEqual(["remove"]);
  });
});

describe("copy link falls back when the clipboard is unavailable or denied (M4)", () => {
  it("true when copied; false when missing or refused", async () => {
    const ok = { writeText: vi.fn(async () => undefined) };
    expect(await copyText("x", ok)).toBe(true);
    expect(ok.writeText).toHaveBeenCalledWith("x");
    expect(await copyText("x", undefined)).toBe(false);
    expect(await copyText("x", null)).toBe(false);
    expect(await copyText("x", { writeText: async () => Promise.reject(new Error("NotAllowedError")) })).toBe(false);
  });
});

describe("a token link opened in a running tab is captured and scrubbed (M3)", () => {
  const fakeWin = (hash: string, pathname = "/", search = "") => {
    const win = {
      location: { pathname, search, hash },
      history: {
        replaceState: vi.fn((_s: unknown, _t: string, url: string) => {
          const u = new URL(url, "https://app.test");
          win.location = { pathname: u.pathname, search: u.search, hash: u.hash };
        }),
      },
    };
    return win;
  };

  it("an invite link in the hash shows the invite page, with the token out of the address bar", () => {
    const win = fakeWin(`#/accept-invite?token=${TOKEN}`);
    const page = pageForHash(win as never);
    expect(page).toEqual({ kind: "accept", token: TOKEN });
    expect(win.history.replaceState).toHaveBeenCalledTimes(1);
    expect(win.location.hash).toBe("#/accept-invite");
    expect(JSON.stringify(win.location)).not.toContain(TOKEN);
  });

  it("a reset link too; a hash without a token is left alone", () => {
    const win = fakeWin(`#/reset-password?token=${TOKEN}`);
    expect(pageForHash(win as never)).toEqual({ kind: "reset", token: TOKEN });
    expect(win.location.hash).toBe("#/reset-password");
    const plain = fakeWin("#/inbox");
    expect(captureTokenLink(plain as never)).toBeNull();
    expect(plain.history.replaceState).not.toHaveBeenCalled();
  });

  it("a malformed token is still scrubbed and reads as an invalid link", () => {
    const win = fakeWin("#/accept-invite?token=short");
    expect(pageForHash(win as never)).toEqual({ kind: "accept", token: "" });
    expect(win.location.hash).toBe("#/accept-invite");
  });
});
