import { describe, expect, it } from "vitest";
import { detailsAsSheet, inboxPane, paneFromHash } from "./inboxPane";

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

  it("from xl the rail is a column only when the inbox area is at least xl wide (views column)", () => {
    expect(detailsAsSheet("wide", 1200)).toBe(true); // 1440 viewport with the full sidebar
    expect(detailsAsSheet("wide", 1279)).toBe(true);
    expect(detailsAsSheet("wide", 1280)).toBe(false);
    expect(detailsAsSheet("wide", 1680)).toBe(false); // 1920 with the full sidebar
    expect(detailsAsSheet("desktop", 900)).toBe(false);
  });
});

describe("inbox panes follow the hash on phones", () => {
  it("Back to the list, a changed conversation, details, deep links and rotation", () => {
    // Back from the thread: no `c=` → the list.
    expect(paneFromHash({ phone: true, conv: null, details: false, open: null })).toEqual({ activeId: null, detailsOpen: false });
    // Another conversation in the hash (Forward, a shared link, a reload) opens it.
    expect(paneFromHash({ phone: true, conv: "cv2", details: false, open: null })).toEqual({ activeId: "cv2", detailsOpen: false });
    expect(paneFromHash({ phone: true, conv: "cv2", details: true, open: null })).toEqual({ activeId: "cv2", detailsOpen: true });
    // Details without a conversation is the list.
    expect(paneFromHash({ phone: true, conv: null, details: true, open: null })).toEqual({ activeId: null, detailsOpen: false });
    // A notification / ?open= link is selected by the open-param hook (which writes c=): never cleared here.
    expect(paneFromHash({ phone: true, conv: null, details: false, open: "cv5" })).toBeNull();
    // Rotated to a tablet: the selection stays.
    expect(paneFromHash({ phone: false, conv: null, details: false, open: null })).toBeNull();
  });
});
