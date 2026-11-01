import { RealtimeGateway } from "./realtime.gateway";

describe("RealtimeGateway payment lock", () => {
  let payload: Record<string, unknown>;
  let isLocked: jest.Mock;
  let gw: RealtimeGateway;
  let client: { handshake: unknown; data: object; join: jest.Mock; disconnect: jest.Mock; id: string };

  beforeEach(() => {
    payload = { sub: "u1", workspaceId: "w1" };
    isLocked = jest.fn().mockResolvedValue(false);
    gw = new RealtimeGateway(
      { verifyAsync: jest.fn().mockImplementation(async () => payload) } as never,
      { isLocked } as never,
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

  it("refuses when the lookup throws (fail closed)", async () => {
    isLocked.mockRejectedValue(new Error("db"));
    await gw.handleConnection(client as never);
    expect(client.join).not.toHaveBeenCalled();
    expect(client.disconnect).toHaveBeenCalled();
  });
});
