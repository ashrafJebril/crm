import { RealtimeGateway, SESSION_RECHECK_MS, sessionRoom, userRoom } from "./realtime.gateway";
import { SessionVersionService } from "../auth/session-version.service";
import { RealtimeService } from "./realtime.service";

describe("RealtimeGateway payment lock", () => {
  let payload: Record<string, unknown>;
  let isLocked: jest.Mock;
  let effective: jest.Mock;
  let gw: RealtimeGateway;
  let client: { handshake: unknown; data: object; join: jest.Mock; disconnect: jest.Mock; id: string };

  beforeEach(() => {
    payload = { sub: "u1", workspaceId: "w1" };
    isLocked = jest.fn().mockResolvedValue(false);
    effective = jest.fn().mockResolvedValue({ key: "agent" });
    gw = new RealtimeGateway(
      { verifyAsync: jest.fn().mockImplementation(async () => payload) } as never,
      { isLocked } as never,
      { effective } as never,
      // SP-26: every token here is current.
      { isCurrent: jest.fn().mockResolvedValue(true), onBump: jest.fn() } as never,
    );
    client = {
      handshake: { auth: { token: "t" }, headers: {} },
      data: {},
      join: jest.fn(),
      disconnect: jest.fn(),
      id: "s1",
    };
  });

  it("joins the room for an unlocked workspace", async () => {
    await gw.handleConnection(client as never);
    expect(client.join).toHaveBeenCalledWith("workspace:w1");
  });

  it("also joins the per-user room", async () => {
    await gw.handleConnection(client as never);
    expect(client.join).toHaveBeenCalledWith("user:w1:u1");
    expect(userRoom("w1", "u1")).toBe("user:w1:u1");
  });

  it("refuses a locked workspace", async () => {
    isLocked.mockResolvedValue(true);
    await gw.handleConnection(client as never);
    expect(client.join).not.toHaveBeenCalled();
    expect(client.disconnect).toHaveBeenCalled();
  });

  it.each(["isSuperAdmin", "impersonating"])("exempts %s sessions", async (flag) => {
    payload[flag] = true;
    isLocked.mockResolvedValue(true);
    await gw.handleConnection(client as never);
    expect(isLocked).not.toHaveBeenCalled();
    expect(client.join).toHaveBeenCalled();
  });

  it("refuses a user who is not (or no longer) a member of the JWT workspace", async () => {
    effective.mockResolvedValue(null);
    await gw.handleConnection(client as never);
    expect(effective).toHaveBeenCalledWith("w1", "u1");
    expect(client.join).not.toHaveBeenCalled();
    expect(client.disconnect).toHaveBeenCalled();
  });

  it.each(["isSuperAdmin", "impersonating"])("%s sessions skip the membership check", async (flag) => {
    payload[flag] = true;
    effective.mockResolvedValue(null);
    await gw.handleConnection(client as never);
    expect(effective).not.toHaveBeenCalled();
    expect(client.join).toHaveBeenCalled();
  });

  it("refuses when the membership lookup throws (fail closed)", async () => {
    effective.mockRejectedValue(new Error("db"));
    await gw.handleConnection(client as never);
    expect(client.join).not.toHaveBeenCalled();
  });

  it("refuses when the lookup throws (fail closed)", async () => {
    isLocked.mockRejectedValue(new Error("db"));
    await gw.handleConnection(client as never);
    expect(client.join).not.toHaveBeenCalled();
    expect(client.disconnect).toHaveBeenCalled();
  });
});

describe("RealtimeService.emitToUser", () => {
  it("emits only to the user room and no-ops before the server boots", () => {
    const emit = jest.fn();
    const to = jest.fn().mockReturnValue({ emit });
    const svc = new RealtimeService({ server: { to } } as never);
    svc.emitToUser("w1", "u1", "notification:new", { id: "n1" });
    expect(to).toHaveBeenCalledWith("user:w1:u1");
    expect(emit).toHaveBeenCalledWith("notification:new", { id: "n1" });
    expect(() => new RealtimeService({} as never).emitToUser("w1", "u1", "e", {})).not.toThrow();
  });
});

describe("RealtimeGateway session version (SP-26 I1)", () => {
  let version: number;
  let sessions: SessionVersionService;
  let payload: Record<string, unknown>;
  let gw: RealtimeGateway;
  const client = () => ({
    handshake: { auth: { token: "t" }, headers: {} },
    data: {},
    join: jest.fn(),
    disconnect: jest.fn(),
    id: "s1",
  });

  beforeEach(() => {
    version = 0;
    sessions = new SessionVersionService({ user: { findUnique: jest.fn(async () => ({ sessionVersion: version })) } } as never);
    payload = { sub: "u1", workspaceId: "w1", sv: 0 };
    gw = new RealtimeGateway(
      { verifyAsync: jest.fn(async () => payload) } as never,
      { isLocked: jest.fn().mockResolvedValue(false) } as never,
      { effective: jest.fn().mockResolvedValue({ key: "agent" }) } as never,
      sessions,
    );
  });

  it("joins the user's session room with a current token", async () => {
    const c = client();
    await gw.handleConnection(c as never);
    expect(c.disconnect).not.toHaveBeenCalled();
    expect(c.join).toHaveBeenCalledWith(sessionRoom("u1"));
  });

  it("a stale sv is refused at connect", async () => {
    version = 2;
    payload = { sub: "u1", workspaceId: "w1", sv: 1 };
    const c = client();
    await gw.handleConnection(c as never);
    expect(c.disconnect).toHaveBeenCalled();
    expect(c.join).not.toHaveBeenCalled();
    // A token without sv reads as 0: refused after any bump too.
    payload = { sub: "u1", workspaceId: "w1" };
    const d = client();
    await gw.handleConnection(d as never);
    expect(d.join).not.toHaveBeenCalled();
  });

  it("a purpose token (the 2FA challenge) is refused", async () => {
    payload = { sub: "u1", workspaceId: "w1", sv: 0, purpose: "2fa" };
    const c = client();
    await gw.handleConnection(c as never);
    expect(c.disconnect).toHaveBeenCalled();
    expect(c.join).not.toHaveBeenCalled();
  });

  it("a bump disconnects the user's open sockets and blocks the reconnect", async () => {
    const disconnectSockets = jest.fn();
    const inRoom = jest.fn(() => ({ disconnectSockets }));
    gw.server = { in: inRoom } as never;
    gw.onModuleInit();
    const c = client();
    await gw.handleConnection(c as never);
    version = 1;
    sessions.bumped("u1");
    expect(inRoom).toHaveBeenCalledWith(sessionRoom("u1"));
    expect(disconnectSockets).toHaveBeenCalledWith(true);
    const again = client();
    await gw.handleConnection(again as never);
    expect(again.join).not.toHaveBeenCalled();
    gw.onModuleDestroy();
    sessions.bumped("u1");
    expect(disconnectSockets).toHaveBeenCalledTimes(1);
  });
});

describe("RealtimeGateway periodic session re-check (SP-26 I1, cross-instance)", () => {
  it("drops sockets whose sv went stale on another instance, one lookup per user and sv", async () => {
    const versions: Record<string, number> = { u1: 1, u2: 0 };
    const findUnique = jest.fn(async ({ where }: { where: { id: string } }) => ({ sessionVersion: versions[where.id] ?? 0 }));
    const sessions = new SessionVersionService({ user: { findUnique } } as never);
    const gw = new RealtimeGateway({} as never, {} as never, {} as never, sessions);
    const sock = (sub: string, sv: number | undefined) => ({ data: { user: { sub, sv, workspaceId: "w1" } }, disconnect: jest.fn() });
    // u1 was bumped to 1 on another machine: its sv-0 sockets are stale.
    const stale = [sock("u1", 0), sock("u1", undefined)];
    const fresh = [sock("u1", 1), sock("u2", 0), sock("u2", 0)];
    const anon = { data: {}, disconnect: jest.fn() };
    gw.server = { sockets: { sockets: new Map([...stale, ...fresh, anon].map((s, i) => [`s${i}`, s])) } } as never;
    expect(await gw.recheckSessions()).toBe(2);
    for (const s of stale) expect(s.disconnect).toHaveBeenCalledWith(true);
    for (const s of [...fresh, anon]) expect(s.disconnect).not.toHaveBeenCalled();
    // Batched and cached: one read per user.
    expect(findUnique).toHaveBeenCalledTimes(2);
    expect(SESSION_RECHECK_MS).toBe(60_000);
  });

  it("runs on a timer from module init until destroy", async () => {
    jest.useFakeTimers();
    try {
      const sessions = { onBump: jest.fn(() => () => undefined), isCurrent: jest.fn() };
      const gw = new RealtimeGateway({} as never, {} as never, {} as never, sessions as never);
      const spy = jest.spyOn(gw, "recheckSessions").mockResolvedValue(0);
      gw.onModuleInit();
      jest.advanceTimersByTime(SESSION_RECHECK_MS * 2);
      expect(spy).toHaveBeenCalledTimes(2);
      gw.onModuleDestroy();
      jest.advanceTimersByTime(SESSION_RECHECK_MS * 3);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});
