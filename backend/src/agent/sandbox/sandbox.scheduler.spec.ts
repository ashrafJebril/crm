import { SandboxScheduler } from "./sandbox.scheduler";

describe("SandboxScheduler", () => {
  it("sweeps expired threads daily and never throws", async () => {
    const sandbox = { sweepExpired: jest.fn(async () => 2) };
    const s = new SandboxScheduler(sandbox as never);
    const now = new Date("2026-11-17T03:30:00Z");
    expect(await s.sweep(now)).toBe(2);
    expect(sandbox.sweepExpired).toHaveBeenCalledWith(now);
    sandbox.sweepExpired.mockRejectedValueOnce(new Error("db down"));
    jest.spyOn((s as unknown as { log: { warn: () => void } }).log, "warn").mockImplementation(() => undefined);
    expect(await s.sweep(now)).toBe(0);
  });

  it("sweepExpired deletes only threads past their expiry", async () => {
    const { sandboxWorld, WS } = await import("./sandbox-test-world");
    const w = sandboxWorld();
    const now = new Date("2026-11-17T00:00:00Z");
    w.prisma.db.agentSandboxThread.push(
      { id: "old", workspaceId: WS, userId: "u1", messages: [], transcript: [], expiresAt: new Date("2026-11-16T23:59:59Z") },
      { id: "live", workspaceId: WS, userId: "u2", messages: [], transcript: [], expiresAt: new Date("2026-11-17T00:00:01Z") },
    );
    expect(await w.sandbox.sweepExpired(now)).toBe(1);
    expect(w.prisma.db.agentSandboxThread.map((t: { id: string }) => t.id)).toEqual(["live"]);
  });
});
