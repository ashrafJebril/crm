import { afterEach, describe, expect, it } from "vitest";
import { makeTx } from "../../lib/tx";
import {
  autoImportAttempted,
  emptyThreadView,
  historyImportPath,
  importingLabel,
  markAutoImportAttempted,
  resetAutoImportAttempts,
  shouldAutoImportHistory,
} from "./historyImport";

const base = {
  activeId: "cv1",
  detail: { id: "cv1", messages: [] as unknown[] },
  rowProvider: "zernio" as string | null,
  isLiveThread: false,
  attempted: autoImportAttempted,
};

afterEach(() => resetAutoImportAttempts());

describe("shouldAutoImportHistory", () => {
  it("imports an empty, loaded Zernio thread once", () => {
    expect(shouldAutoImportHistory(base)).toBe(true);
    markAutoImportAttempted("cv1");
    // One automatic attempt per conversation per session: never loops.
    expect(shouldAutoImportHistory(base)).toBe(false);
    // Another conversation still gets its own attempt.
    expect(shouldAutoImportHistory({ ...base, activeId: "cv2", detail: { id: "cv2", messages: [] } })).toBe(true);
  });

  it("waits for this conversation's own detail (not a placeholder or the previous thread)", () => {
    expect(shouldAutoImportHistory({ ...base, detail: undefined })).toBe(false);
    expect(shouldAutoImportHistory({ ...base, detail: { id: "other", messages: [] } })).toBe(false);
    expect(shouldAutoImportHistory({ ...base, detail: { id: "cv1", messages: [], placeholder: true } })).toBe(false);
    expect(shouldAutoImportHistory({ ...base, detail: { id: "cv1" } })).toBe(false);
  });

  it("never for a thread that has messages", () => {
    expect(shouldAutoImportHistory({ ...base, detail: { id: "cv1", messages: [{ body: "hi" }] } })).toBe(false);
  });

  it("only for Zernio channels (row, else detail provider)", () => {
    expect(shouldAutoImportHistory({ ...base, rowProvider: "telegram" })).toBe(false);
    expect(shouldAutoImportHistory({ ...base, rowProvider: "meta" })).toBe(false);
    expect(shouldAutoImportHistory({ ...base, rowProvider: null })).toBe(false);
    expect(
      shouldAutoImportHistory({ ...base, rowProvider: null, detail: { id: "cv1", messages: [], channelProvider: "zernio" } }),
    ).toBe(true);
  });

  it("never for live FB/IG threads or with nothing open", () => {
    expect(shouldAutoImportHistory({ ...base, isLiveThread: true })).toBe(false);
    expect(shouldAutoImportHistory({ ...base, activeId: null })).toBe(false);
  });
});

describe("emptyThreadView", () => {
  it("a non-Zernio thread keeps the plain empty text", () => {
    expect(emptyThreadView({ isZernio: false, status: undefined, autoAttempted: false })).toBe("no-messages");
  });

  it("a Zernio thread never shows the bare empty text", () => {
    // Before the automatic attempt starts (same render it is decided in).
    expect(emptyThreadView({ isZernio: true, status: undefined, autoAttempted: false })).toBe("importing");
    expect(emptyThreadView({ isZernio: true, status: { phase: "importing" }, autoAttempted: true })).toBe("importing");
    for (const failed of [true, false]) {
      expect(
        emptyThreadView({
          isZernio: true,
          status: { phase: "done", imported: 0, failed, throttled: false },
          autoAttempted: true,
        }),
      ).toBe("none-found");
    }
    // Attempted earlier this session, outcome not in this Inbox's state: honest empty state.
    expect(emptyThreadView({ isZernio: true, status: undefined, autoAttempted: true })).toBe("none-found");
  });
});

describe("copy and path", () => {
  it("names the channel in both languages", () => {
    expect(importingLabel("instagram", makeTx("en"))).toBe("Loading history from Instagram…");
    expect(importingLabel("instagram", makeTx("ar"))).toBe("جارٍ تحميل السجل من Instagram…");
    expect(importingLabel(null, makeTx("en"))).toBe("Loading history from the channel…");
  });

  it("posts to the per-conversation import route", () => {
    expect(historyImportPath("cv 1")).toBe("/integrations/zernio/db-conversations/cv%201/import-history");
  });
});
