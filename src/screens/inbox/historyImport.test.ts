import { afterEach, describe, expect, it } from "vitest";
import { makeTx } from "../../lib/tx";
import {
  autoImportAttempted,
  emptyThreadCopy,
  emptyThreadView,
  historyImportPath,
  importingLabel,
  markAutoImportAttempted,
  resetAutoImportAttempts,
  shouldAutoImportHistory,
  type EmptyThreadView,
  type HistoryImportReason,
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
  const done = (over: { imported?: number; failed?: boolean; reason?: HistoryImportReason } = {}) =>
    emptyThreadView({
      isZernio: true,
      status: { phase: "done", imported: over.imported ?? 0, failed: over.failed ?? false, reason: over.reason },
      autoAttempted: true,
    });

  it("a non-Zernio thread keeps the plain empty text", () => {
    expect(emptyThreadView({ isZernio: false, status: undefined, autoAttempted: false })).toBe("no-messages");
  });

  it("loading: before the automatic attempt starts and while it runs", () => {
    expect(emptyThreadView({ isZernio: true, status: undefined, autoAttempted: false })).toBe("importing");
    expect(emptyThreadView({ isZernio: true, status: { phase: "importing" }, autoAttempted: true })).toBe("importing");
  });

  it("each outcome has its own state (M2/M3)", () => {
    expect(done({ failed: true })).toBe("failed");
    expect(done()).toBe("none-found");
    expect(done({ reason: "channel_unavailable" })).toBe("channel-off");
    expect(done({ reason: "throttled" })).toBe("checking");
    expect(done({ reason: "busy" })).toBe("checking");
    expect(done({ reason: "rate_limited" })).toBe("rate-limited");
    for (const reason of ["not_zernio", "no_external_id", "has_messages"] as const) {
      expect(done({ reason })).toBe("no-messages");
    }
    // Attempted earlier this session, outcome not in this Inbox's state.
    expect(emptyThreadView({ isZernio: true, status: undefined, autoAttempted: true })).toBe("none-found");
  });
});

describe("emptyThreadCopy", () => {
  const en = makeTx("en");
  const ar = makeTx("ar");
  const views: EmptyThreadView[] = ["importing", "checking", "rate-limited", "failed", "channel-off", "none-found"];

  it("the plain empty state has no special copy", () => {
    expect(emptyThreadCopy("no-messages", "instagram", en)).toBeNull();
  });

  it("every state has distinct copy in both languages; Retry where trying again can help", () => {
    for (const tx of [en, ar]) {
      const texts = views.map((v) => emptyThreadCopy(v, "instagram", tx)!.text);
      expect(new Set(texts).size).toBe(views.length);
    }
    expect(Object.fromEntries(views.map((v) => [v, emptyThreadCopy(v, "instagram", en)!.retry]))).toEqual({
      importing: false,
      checking: true,
      "rate-limited": true,
      failed: true,
      "channel-off": false,
      "none-found": true,
    });
    expect(emptyThreadCopy("failed", "instagram", en)!.text).toBe("Couldn’t load history.");
    expect(emptyThreadCopy("checking", "instagram", en)!.text).toBe("Checking history…");
    expect(emptyThreadCopy("none-found", "instagram", en)!.text).toBe("No message history found for this conversation.");
  });

  it("names the channel that is not connected", () => {
    expect(emptyThreadCopy("channel-off", "instagram", en)!.text).toBe("The Instagram channel isn’t connected.");
    expect(emptyThreadCopy("channel-off", "whatsapp", ar)!.text).toBe("قناة WhatsApp غير متصلة.");
    expect(emptyThreadCopy("channel-off", null, en)!.text).toBe("This channel isn’t connected.");
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
