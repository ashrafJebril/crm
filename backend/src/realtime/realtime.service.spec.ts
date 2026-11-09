import { RealtimeService } from "./realtime.service";

describe("RealtimeService.emitToWidgetVisitor (SP-19 stub for T3)", () => {
  it("is a no-op until a widget server is attached", () => {
    const svc = new RealtimeService({ server: undefined } as never);
    expect(() => svc.emitToWidgetVisitor("ch1", "v1", "widget.message", {})).not.toThrow();
  });

  it("emits to the visitor's room once attached", () => {
    const svc = new RealtimeService({ server: undefined } as never);
    const emit = jest.fn();
    const to = jest.fn(() => ({ emit }));
    svc.attachWidgetServer({ to });
    svc.emitToWidgetVisitor("ch1", "v1", "widget.message", { id: "m" });
    expect(to).toHaveBeenCalledWith("widget:ch1:v1");
    expect(emit).toHaveBeenCalledWith("widget.message", { id: "m" });
  });
});
