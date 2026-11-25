import { describe, expect, it, vi } from "vitest";

const fake = { connected: true, connect: vi.fn(), disconnect: vi.fn() };
fake.disconnect.mockImplementation(() => fake);
vi.mock("socket.io-client", () => ({ io: vi.fn(() => fake) }));

describe("reconnectSocket (SP-26 review I2)", () => {
  it("does nothing before a socket exists, then reconnects the existing one with the new token", async () => {
    const rt = await import("./realtime");
    expect(rt.reconnectSocket()).toBe(false);
    expect(fake.connect).not.toHaveBeenCalled();
    rt.ensureSocket();
    expect(rt.reconnectSocket()).toBe(true);
    expect(fake.disconnect).toHaveBeenCalledTimes(1);
    expect(fake.connect).toHaveBeenCalledTimes(1);
    rt.disconnectSocket();
    expect(rt.reconnectSocket()).toBe(false);
  });
});
