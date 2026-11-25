import { describe, expect, it } from "vitest";
import { boardColumnOf, groupByColumn, groupContactIds, planBoardMove } from "./boardLogic";

const c = (status: any, escalated?: boolean) => ({ status, escalated });

describe("boardLogic", () => {
  it("escalated wins over status; spam hidden", () => {
    expect(boardColumnOf(c("human", true))).toBe("escalated");
    expect(boardColumnOf(c("resolved", true))).toBe("escalated");
    expect(boardColumnOf(c("pending_customer"))).toBe("pending_customer");
    expect(boardColumnOf(c("spam"))).toBeNull();
    expect(boardColumnOf(c("spam", true))).toBe("escalated");
  });
  it("plans moves", () => {
    expect(planBoardMove(c("human"), "human")).toEqual({ kind: "noop" });
    expect(planBoardMove(c("human", true), "escalated")).toEqual({ kind: "noop" });
    expect(planBoardMove(c("human"), "escalated")).toEqual({ kind: "escalate" });
    expect(planBoardMove(c("human"), "resolved")).toEqual({ kind: "patch", body: { status: "resolved" } });
    expect(planBoardMove(c("human", true), "closed")).toEqual({
      kind: "patch",
      body: { escalated: false, status: "closed" },
    });
    // Escalated card whose status already equals the target still needs de-escalating.
    expect(planBoardMove(c("human", true), "human")).toEqual({
      kind: "patch",
      body: { escalated: false, status: "human" },
    });
  });
  it("groups by column and drops spam", () => {
    const g = groupByColumn([c("human"), c("human", true), c("spam"), c("closed")]);
    expect(g.human).toHaveLength(1);
    expect(g.escalated).toHaveLength(1);
    expect(g.closed).toHaveLength(1);
    expect(g.resolved).toHaveLength(0);
  });
  it("collects unique DB contact ids only", () => {
    const live = (x: { id: string }) => x.id.startsWith("t_") || x.id.startsWith("ig:");
    expect(
      groupContactIds(
        [
          { id: "a", contactId: "c1" },
          { id: "b", contactId: "c1" },
          { id: "t_1", contactId: "c2" },
          { id: "ig:2", contactId: "c3" },
          { id: "d", contactId: "" },
          { id: "e", contactId: "c4" },
        ],
        live,
      ),
    ).toEqual(["c1", "c4"]);
  });
});
