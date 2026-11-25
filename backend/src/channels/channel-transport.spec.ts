import { ChannelTransportRegistry } from "./channel-transport";

describe("ChannelTransportRegistry", () => {
  it("registers one transport per provider", () => {
    const r = new ChannelTransportRegistry();
    const t = { provider: "telegram", sendText: jest.fn() };
    r.register(t);
    expect(r.get("telegram")).toBe(t);
    expect(r.get("native")).toBeUndefined();
    expect(r.providers()).toEqual(["telegram"]);
    expect(() => r.register({ provider: "telegram", sendText: jest.fn() })).toThrow(/already registered/);
  });
});
