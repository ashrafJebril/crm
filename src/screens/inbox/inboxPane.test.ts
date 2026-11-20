import { describe, expect, it } from "vitest";
import { detailsAsSheet, inboxPane } from "./inboxPane";

describe("inbox pane by layout and selection", () => {
  it("phone: list → thread → details, and Back clears to the list", () => {
    expect(inboxPane("phone", { selected: false, detailsOpen: false })).toBe("list");
    expect(inboxPane("phone", { selected: true, detailsOpen: false })).toBe("thread");
    expect(inboxPane("phone", { selected: true, detailsOpen: true })).toBe("details");
    // Details without a conversation is meaningless: the list.
    expect(inboxPane("phone", { selected: false, detailsOpen: true })).toBe("list");
    // A selection cleared by Back.
    let selected = true;
    expect(inboxPane("phone", { selected, detailsOpen: false })).toBe("thread");
    selected = false;
    expect(inboxPane("phone", { selected, detailsOpen: false })).toBe("list");
  });

  it("tablet and desktop: every pane", () => {
    for (const layout of ["tablet", "desktop", "wide"] as const) {
      for (const selected of [false, true]) {
        for (const detailsOpen of [false, true]) expect(inboxPane(layout, { selected, detailsOpen })).toBe("all");
      }
    }
    expect(detailsAsSheet("tablet")).toBe(true);
    expect(detailsAsSheet("desktop")).toBe(false);
    expect(detailsAsSheet("phone")).toBe(false);
  });
});
