import { makeFakePrisma } from "../channels/test-prisma";
import { AgentToolCallRecorder, errorCodeOf } from "./agent-tool-call.recorder";
import { AgentToolCallPruneScheduler, PRUNE_BATCH } from "./agent-tool-call-prune.scheduler";

const flush = () => new Promise((r) => setImmediate(r));

describe("agent tool-call log (SP-22)", () => {
  it("records outcome and duration only; a failure never throws", async () => {
    const prisma: any = makeFakePrisma({ agentToolCall: [] } as never);
    const rec = new AgentToolCallRecorder(prisma);
    rec.record({ workspaceId: "ws1", tool: "tag_contact", skillKey: "lead_capture", outcome: "error", errorCode: "skills.tag_not_allowed", durationMs: 12.4 });
    rec.record({ workspaceId: "ws1", tool: "list_photos", skillKey: "photos", outcome: "ok", durationMs: 3 });
    await flush();
    expect(prisma.db.agentToolCall.map((r: any) => [r.tool, r.outcome, r.errorCode, r.durationMs])).toEqual([
      ["tag_contact", "error", "skills.tag_not_allowed", 12],
      ["list_photos", "ok", null, 3],
    ]);
    prisma.agentToolCall.create = jest.fn(() => Promise.reject(new Error("db down")));
    expect(() => rec.record({ workspaceId: "ws1", tool: "x", skillKey: null, outcome: "ok", durationMs: 1 })).not.toThrow();
    prisma.agentToolCall.create = jest.fn(() => {
      throw new Error("sync boom");
    });
    expect(() => rec.record({ workspaceId: "ws1", tool: "x", skillKey: null, outcome: "ok", durationMs: 1 })).not.toThrow();
    await flush();
    expect(errorCodeOf(new Error("tickets.too_many_open"))).toBe("tickets.too_many_open");
    expect(errorCodeOf(new Error("Unexpected error"))).toBe("error");
  });

  it("prune deletes only old rows of the given workspaces", async () => {
    const now = Date.now();
    const old = new Date(now - 100 * 86_400_000);
    const fresh = new Date(now - 10 * 86_400_000);
    const rows = [
      { id: "a", workspaceId: "ws1", tool: "t", outcome: "ok", durationMs: 1, at: old },
      { id: "b", workspaceId: "ws1", tool: "t", outcome: "ok", durationMs: 1, at: fresh },
      { id: "c", workspaceId: "ws2", tool: "t", outcome: "ok", durationMs: 1, at: old },
      { id: "d", workspaceId: "ws3", tool: "t", outcome: "ok", durationMs: 1, at: old },
    ];
    const prisma: any = makeFakePrisma({ agentToolCall: rows } as never);
    prisma.raw = prisma;
    const s = new AgentToolCallPruneScheduler(prisma);
    const before = new Date(now - 90 * 86_400_000);
    expect(await s.prune({ before, workspaceIds: ["ws1", "ws2"] })).toBe(2);
    expect(prisma.db.agentToolCall.map((r: any) => r.id).sort()).toEqual(["b", "d"]);
    expect(await s.prune({ before })).toBe(1);
    expect(prisma.db.agentToolCall.map((r: any) => r.id)).toEqual(["b"]);
    expect(PRUNE_BATCH).toBe(5000);
  });
});
