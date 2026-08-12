import { SocialService } from "./social.service";
import { ZernioService } from "../integrations/zernio.service";

describe("SocialService", () => {
  let zernio: jest.Mocked<Pick<ZernioService, "publish">>;
  let svc: SocialService;

  beforeEach(() => {
    zernio = { publish: jest.fn().mockResolvedValue({ id: "z1", status: "scheduled" }) };
    svc = new SocialService(zernio as unknown as ZernioService);
  });

  it("forwards scheduledFor + timezone to ZernioService.publish", async () => {
    const res = await svc.publish(
      "ws1",
      {
        content: "hi",
        channels: ["facebook", "instagram"],
        scheduledFor: "2026-08-13T10:00:00.000Z",
        timezone: "Asia/Riyadh",
      },
      "http://localhost:3001",
    );
    expect(zernio.publish).toHaveBeenCalledWith(
      "ws1",
      expect.objectContaining({
        scheduledFor: "2026-08-13T10:00:00.000Z",
        timezone: "Asia/Riyadh",
      }),
      "http://localhost:3001",
    );
    expect(res.facebook).toEqual({ ok: true, postId: "z1" });
    expect(res.instagram).toEqual({ ok: true, postId: "z1" });
  });

  it("maps failures onto every requested channel", async () => {
    zernio.publish.mockRejectedValue(new Error("boom"));
    const res = await svc.publish(
      "ws1",
      { content: "hi", channels: ["facebook"] },
      "http://localhost:3001",
    );
    expect(res.facebook.ok).toBe(false);
    expect(res.facebook.error).toBe("boom");
  });
});
