import { describe, expect, it } from "vitest";
import { isShortcut, shortcutAllowed, shouldCloseOnEscape, trapTarget } from "./drawerKeys";

describe("drawer keys", () => {
  it("Escape inside the @ list closes only the list, never the drawer", () => {
    expect(shouldCloseOnEscape({ key: "Escape", defaultPrevented: false }, false)).toBe(true);
    // The suggestion list handled it (preventDefault).
    expect(shouldCloseOnEscape({ key: "Escape", defaultPrevented: true }, false)).toBe(false);
    // The list is open.
    expect(shouldCloseOnEscape({ key: "Escape", defaultPrevented: false }, true)).toBe(false);
    expect(shouldCloseOnEscape({ key: "Enter", defaultPrevented: false }, false)).toBe(false);
  });

  it("Ctrl/Cmd+J is not taken while typing in a field outside the drawer", () => {
    const ev = (o: Partial<{ key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }>) => ({ key: "j", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...o });
    expect(isShortcut(ev({ ctrlKey: true }))).toBe(true);
    expect(isShortcut(ev({ metaKey: true, key: "J" }))).toBe(true);
    expect(isShortcut(ev({ ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isShortcut(ev({}))).toBe(false);
    const outside = { closest: () => null };
    const inside = { closest: (s: string) => (s === ".copilot-drawer" ? {} : null) };
    expect(shortcutAllowed(null)).toBe(true);
    expect(shortcutAllowed({ tagName: "BUTTON", ...outside })).toBe(true);
    expect(shortcutAllowed({ tagName: "INPUT", ...outside })).toBe(false);
    expect(shortcutAllowed({ tagName: "textarea", ...outside })).toBe(false);
    expect(shortcutAllowed({ tagName: "DIV", isContentEditable: true, ...outside })).toBe(false);
    expect(shortcutAllowed({ tagName: "DIV", isContentEditable: true, ...inside })).toBe(true);
  });

  it("Tab wraps inside the drawer", () => {
    const f = ["a", "b", "c"];
    expect(trapTarget(f, "c", false)).toBe("a");
    expect(trapTarget(f, "a", true)).toBe("c");
    expect(trapTarget(f, "b", false)).toBeNull();
    expect(trapTarget(f, null, false)).toBe("a");
    expect(trapTarget(f, "x", true)).toBe("c");
    expect(trapTarget([], "a", false)).toBeNull();
  });
});
