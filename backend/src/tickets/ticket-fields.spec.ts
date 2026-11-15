import {
  TICKET_ATTACHMENTS_MAX,
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  parseCsvList,
  priorityRank,
} from "./ticket-fields";

describe("SP-09 ticket fields", () => {
  it("priorities and categories are the plan's exact key lists", () => {
    expect(TICKET_PRIORITIES).toEqual(["urgent", "high", "normal", "low"]);
    expect(TICKET_CATEGORIES).toEqual([
      "general_inquiry",
      "complaint",
      "service_request",
      "payment_problem",
      "execution_delay",
      "incorrect_data",
      "ticket_follow_up",
      "data_modification",
      "other",
    ]);
    expect(TICKET_ATTACHMENTS_MAX).toBe(50);
  });

  it("priorityRank: urgent 0 … low 3; an unknown legacy value ranks as normal", () => {
    expect(TICKET_PRIORITIES.map(priorityRank)).toEqual([0, 1, 2, 3]);
    expect(priorityRank("medium")).toBe(priorityRank("normal"));
    expect(priorityRank(null)).toBe(priorityRank("normal"));
  });

  it("parseCsvList keeps known values in list order, drops unknown ones, undefined when empty", () => {
    expect(parseCsvList("low, urgent,low", TICKET_PRIORITIES)).toEqual(["urgent", "low"]);
    expect(parseCsvList(["high", "nope"], TICKET_PRIORITIES)).toEqual(["high"]);
    expect(parseCsvList("nope,,", TICKET_PRIORITIES)).toBeUndefined();
    expect(parseCsvList("", TICKET_PRIORITIES)).toBeUndefined();
    expect(parseCsvList(undefined, TICKET_PRIORITIES)).toBeUndefined();
    expect(parseCsvList("complaint", TICKET_CATEGORIES)).toEqual(["complaint"]);
  });
});
