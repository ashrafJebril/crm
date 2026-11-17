import { sealAction, sealMatches } from "./args-hash";
import { hashAction } from "../ads/ads-args-hash";

describe("copilot action seal", () => {
  const card = { title: "move_ticket_stage", changes: [{ label: "ticket.stage", before: "New", after: "Working" }] };
  const args = { ticketId: "t1", stageId: "s2", fromStageId: "s1" };

  it("uses the ads canonicalisation: key order does not matter, values do", () => {
    const h = sealAction("move_ticket_stage", args, card);
    expect(h).toBe(hashAction("move_ticket_stage", { args, card }, "copilot"));
    expect(sealAction("move_ticket_stage", { fromStageId: "s1", stageId: "s2", ticketId: "t1" }, { changes: card.changes, title: card.title })).toBe(h);
    expect(sealAction("move_ticket_stage", { ...args, stageId: "s-won" }, card)).not.toBe(h);
    expect(sealAction("create_activity", args, card)).not.toBe(h);
    expect(sealAction("move_ticket_stage", args, { ...card, title: "x" })).not.toBe(h);
  });

  it("args tampering is refused (sealMatches)", () => {
    const row = { tool: "move_ticket_stage", argsJson: args, card, argsHash: sealAction("move_ticket_stage", args, card) };
    expect(sealMatches(row)).toBe(true);
    expect(sealMatches({ ...row, argsJson: { ...args, stageId: "s-lost" } })).toBe(false);
    expect(sealMatches({ ...row, tool: "create_activity" })).toBe(false);
  });
});
