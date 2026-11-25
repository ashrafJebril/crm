import {
  markRepliedPatch,
  mergeRecipientEvent,
  mergeRecipientEvents,
  RECIPIENT_STATUSES,
  RecipientEvent,
  RecipientEventKind,
  RecipientState,
  STATUS_RANK,
} from "./recipient-status";

const T = (m: number) => new Date(Date.UTC(2026, 10, 9, 10, m));
const EVENTS: Record<RecipientEventKind, RecipientEvent> = {
  sent: { kind: "sent", at: T(0), messageId: "wamid.1" },
  delivered: { kind: "delivered", at: T(1) },
  read: { kind: "read", at: T(5) },
  failed: { kind: "failed", at: T(2), failureCode: "meta:131026", failureReason: "Message undeliverable" },
};

function permutations<X>(xs: X[]): X[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

const queued: RecipientState = { status: "queued" };

describe("recipient status rule", () => {
  it("lists the seven statuses and ranks them forward", () => {
    expect(RECIPIENT_STATUSES).toEqual(["queued", "sent", "delivered", "read", "replied", "failed", "skipped"]);
    const order = ["queued", "sent", "failed", "delivered", "read", "replied"] as const;
    for (let i = 1; i < order.length; i++) expect(STATUS_RANK[order[i]]).toBeGreaterThan(STATUS_RANK[order[i - 1]]);
  });

  it("mergeRecipientEvent: every permutation of [sent, delivered, read, failed], each applied twice, ends the same", () => {
    const kinds = Object.keys(EVENTS) as RecipientEventKind[];
    const perms = permutations(kinds);
    expect(perms).toHaveLength(24);
    // The replay carries later times (a redelivered webhook): first write still wins.
    const later = (e: RecipientEvent): RecipientEvent => ({ ...e, at: new Date(e.at!.getTime() + 3_600_000), messageId: "wamid.2" });
    const results = perms.map((p) => {
      let row: RecipientState = queued;
      for (const k of p) row = mergeRecipientEvent(row, EVENTS[k]).next;
      for (const k of p) row = mergeRecipientEvent(row, later(EVENTS[k])).next;
      return row;
    });
    for (const r of results) {
      expect(r.status).toBe("read");
      expect(r.sentAt).toEqual(T(0));
      expect(r.deliveredAt).toEqual(T(1));
      expect(r.readAt).toEqual(T(5));
      expect(r.messageId).toBe("wamid.1");
    }
    // Applying the whole sequence again changes nothing (idempotent).
    for (const p of perms) {
      let row: RecipientState = queued;
      for (const k of p) row = mergeRecipientEvent(row, EVENTS[k]).next;
      for (const k of p) expect(mergeRecipientEvent(row, EVENTS[k]).changed).toBe(false);
    }
  });

  it("every single status reached by every pair of events is the higher-ranked one", () => {
    const kinds = Object.keys(EVENTS) as RecipientEventKind[];
    for (const a of kinds) {
      for (const b of kinds) {
        const r = mergeRecipientEvents(queued, [EVENTS[a], EVENTS[b]]).next;
        const want = STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
        expect(r.status).toBe(want);
      }
    }
  });

  it("skipped is immutable", () => {
    const skipped: RecipientState = { status: "skipped", failureCode: "skip:opted_out" };
    for (const e of Object.values(EVENTS)) {
      const r = mergeRecipientEvent(skipped, e);
      expect(r.changed).toBe(false);
      expect(r.next).toMatchObject({ status: "skipped", failureCode: "skip:opted_out", sentAt: null, messageId: null });
    }
    expect(markRepliedPatch({ status: "skipped" }, { at: T(9), text: "hi" })).toBeNull();
  });

  it("failed after delivered is ignored", () => {
    const delivered = mergeRecipientEvents(queued, [EVENTS.sent, EVENTS.delivered]).next;
    const r = mergeRecipientEvent(delivered, EVENTS.failed);
    expect(r.changed).toBe(false);
    expect(r.next).toMatchObject({ status: "delivered", failureCode: null, failureReason: null });
  });

  it("delivered after failed wins and keeps the failure code", () => {
    const failed = mergeRecipientEvent(queued, EVENTS.failed).next;
    expect(failed).toMatchObject({ status: "failed", failureCode: "meta:131026" });
    const r = mergeRecipientEvent(failed, EVENTS.delivered);
    expect(r.changed).toBe(true);
    expect(r.next).toMatchObject({ status: "delivered", deliveredAt: T(1), failureCode: "meta:131026", failureReason: "Message undeliverable" });
  });

  it("a failure without a code is completed later by one that has it (first write wins)", () => {
    const bare = mergeRecipientEvent(queued, { kind: "failed", at: null }).next;
    expect(bare).toMatchObject({ status: "failed", failureCode: null });
    const coded = mergeRecipientEvent(bare, EVENTS.failed).next;
    expect(coded.failureCode).toBe("meta:131026");
    const again = mergeRecipientEvent(coded, { kind: "failed", failureCode: "meta:1" });
    expect(again.changed).toBe(false);
  });

  it("read before delivered keeps both timestamps", () => {
    const r = mergeRecipientEvents(queued, [EVENTS.read, EVENTS.delivered]).next;
    expect(r).toMatchObject({ status: "read", readAt: T(5), deliveredAt: T(1) });
  });

  it("an event with no time moves the status but writes no timestamp; replied never moves back", () => {
    const r = mergeRecipientEvent(queued, { kind: "read", at: null }).next;
    expect(r).toMatchObject({ status: "read", readAt: null });
    const replied: RecipientState = { status: "replied" };
    const after = mergeRecipientEvent(replied, EVENTS.read).next;
    expect(after.status).toBe("replied");
    expect(after.readAt).toEqual(T(5));
  });

  it("markRepliedPatch: first reply wins, text and payload are capped, failed rows can reply", () => {
    const p = markRepliedPatch({ status: "failed" }, { at: T(30), text: "x".repeat(1200), buttonPayload: "p".repeat(300), inboundMessageId: "m1" });
    expect(p).toEqual({ status: "replied", repliedAt: T(30), replyText: "x".repeat(1000), buttonPayload: "p".repeat(256), replyMessageId: "m1" });
    expect(markRepliedPatch({ status: "replied", repliedAt: T(30) }, { at: T(31), text: "again" })).toBeNull();
    expect(markRepliedPatch({ status: "read" }, { at: T(31), text: "hi" })?.buttonPayload).toBeNull();
  });
});
