import { afterEach, describe, expect, it, vi } from "vitest";
import { _resetLeaveGuards, confirmLeave, guardHashChange, navigateIfAllowed, pendingLeaveMessage, registerLeaveGuard } from "./leaveGuard";

const MSG = "You have unsaved changes. Leave anyway?";

/** A tiny model of the settings tabs / router: state changes only through navigateIfAllowed, as Settings.setTab and useRoute.setRoute do. */
function nav<T>(start: T) {
  const s = { current: start, hash: `#/${String(start)}` };
  const go = (next: T, ask: (m: string) => boolean) =>
    navigateIfAllowed(() => {
      s.hash = `#/${String(next)}`;
      s.current = next;
    }, ask);
  return { s, go };
}

afterEach(() => _resetLeaveGuards());

describe("leave guard: settings tabs and routes ask before changing state", () => {
  it("switch tab while dirty and cancel → stays, edits kept", () => {
    const off = registerLeaveGuard(() => MSG);
    const { s, go } = nav("workspace");
    const ask = vi.fn(() => false);
    expect(go("members", ask)).toBe(false);
    expect(ask).toHaveBeenCalledWith(MSG);
    expect(s.current).toBe("workspace");
    expect(s.hash).toBe("#/workspace");
    // The guard is still armed.
    expect(pendingLeaveMessage()).toBe(MSG);
    off();
  });

  it("switch tab while dirty and confirm → leaves, and the following hashchange does not ask again", () => {
    registerLeaveGuard(() => MSG);
    const { s, go } = nav("workspace");
    expect(go("members", () => true)).toBe(true);
    expect(s.current).toBe("members");
    const ask = vi.fn(() => false);
    const stop = vi.fn();
    expect(guardHashChange({ oldURL: "http://x/#/settings", stopImmediatePropagation: stop }, { ask, pushState: vi.fn() })).toBe("allowed");
    expect(ask).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it("route change while dirty and cancel → stays", () => {
    registerLeaveGuard(() => MSG);
    const { s, go } = nav("settings");
    expect(go("inbox", () => false)).toBe(false);
    expect(s.current).toBe("settings");
    expect(s.hash).toBe("#/settings");
  });

  it("route change while dirty and confirm → leaves", () => {
    registerLeaveGuard(() => MSG);
    const { s, go } = nav("settings");
    expect(go("inbox", () => true)).toBe(true);
    expect(s.current).toBe("inbox");
    expect(s.hash).toBe("#/inbox");
  });

  it("nothing pending → no prompt; a clean guard does not ask", () => {
    const ask = vi.fn(() => false);
    expect(confirmLeave(ask)).toBe(true);
    registerLeaveGuard(() => null);
    expect(confirmLeave(ask)).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it("the workspace switcher path uses the same confirm", () => {
    registerLeaveGuard(() => MSG);
    expect(confirmLeave(() => false)).toBe(false);
    expect(confirmLeave(() => true)).toBe(true);
    expect(pendingLeaveMessage()).toBeNull();
  });
});

describe("leave guard: Back/Forward and typed URLs (hashchange)", () => {
  it("cancel → event stopped and the old URL pushed back (one new entry, no replace), so Back still works", () => {
    registerLeaveGuard(() => MSG);
    const stop = vi.fn();
    const pushState = vi.fn();
    expect(guardHashChange({ oldURL: "http://x/#/settings", stopImmediatePropagation: stop }, { ask: () => false, pushState })).toBe("cancelled");
    expect(stop).toHaveBeenCalledTimes(1);
    expect(pushState).toHaveBeenCalledWith("http://x/#/settings");
    // Still guarded: the next Back asks again.
    expect(pendingLeaveMessage()).toBe(MSG);
  });

  it("confirm → allowed, nothing pushed", () => {
    registerLeaveGuard(() => MSG);
    const pushState = vi.fn();
    expect(guardHashChange({ oldURL: "http://x/#/settings", stopImmediatePropagation: vi.fn() }, { ask: () => true, pushState })).toBe("allowed");
    expect(pushState).not.toHaveBeenCalled();
  });

  it("a synthetic event with no oldURL is never cancelled", () => {
    registerLeaveGuard(() => MSG);
    const ask = vi.fn(() => false);
    const stop = vi.fn();
    expect(guardHashChange({ oldURL: "", stopImmediatePropagation: stop }, { ask, pushState: vi.fn() })).toBe("allowed");
    expect(guardHashChange({ stopImmediatePropagation: stop }, { ask, pushState: vi.fn() })).toBe("allowed");
    expect(ask).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });
});
