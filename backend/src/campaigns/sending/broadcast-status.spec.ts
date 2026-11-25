import { aggregateBroadcastStatus } from "./broadcast-status";

const s = (status: string, n = 0) => ({ status, sent: n, delivered: n, read: n, failed: n });

describe("aggregateBroadcastStatus", () => {
  it.each([
    [[], "draft"],
    [["completed"], "completed"],
    [["completed", "completed"], "completed"],
    [["scheduled", "scheduled"], "scheduled"],
    [["sending", "completed"], "sending"],
    [["scheduled", "completed"], "sending"],
    [["draft", "sending"], "sending"],
    [["partially_sent", "completed"], "sending"],
    [["completed", "failed"], "completed"],
    [["failed", "cancelled"], "failed"],
    [["cancelled", "cancelled"], "cancelled"],
    [["completed", "cancelled"], "completed"],
    [["failed", "failed"], "failed"],
  ])("%j -> %s", (statuses, expected) => {
    expect(aggregateBroadcastStatus((statuses as string[]).map((x) => s(x))).status).toBe(expected);
  });

  it("sums the counters across broadcasts", () => {
    expect(aggregateBroadcastStatus([s("completed", 2), s("sending", 3), { status: "sending", sent: 1, delivered: 0, read: 0, failed: 4 }])).toEqual({
      status: "sending",
      sent: 6,
      delivered: 5,
      read: 5,
      failed: 9,
    });
  });
});
