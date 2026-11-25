import { Logger } from "@nestjs/common";
import { IS_PUBLIC_KEY } from "../auth/public.decorator";
import { ADS_TOKEN, isolateEnv, META_ADS_ENV } from "../channels/whatsapp/test-graph";
import { MetaAdsController } from "./meta-ads.controller";
import { ENC_KEY, world } from "./test-meta-ads";

describe("MetaAdsController", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = isolateEnv({ ...META_ADS_ENV, TOKEN_ENC_KEY: ENC_KEY });
    process.env.FRONTEND_PUBLIC_URL = "https://app.example.com";
    for (const m of ["log", "warn", "error", "debug"] as const) jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined);
  });
  afterEach(() => {
    restore();
    delete process.env.FRONTEND_PUBLIC_URL;
    jest.restoreAllMocks();
  });

  it("the OAuth callback is @Public() (Meta's redirect carries no session), and nothing else is", () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, MetaAdsController.prototype.callback)).toBe(true);
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, MetaAdsController)).toBeUndefined();
    for (const m of ["connection", "start", "candidates", "save", "check", "disconnect"] as const) {
      expect({ m, pub: Reflect.getMetadata(IS_PUBLIC_KEY, MetaAdsController.prototype[m]) }).toEqual({ m, pub: undefined });
    }
  });

  const fakeRes = () => {
    const res = { redirect: jest.fn() };
    return res;
  };

  it("the callback answers 302 to the frontend, without code, state or token", async () => {
    const w = world();
    const ctrl = new MetaAdsController(w.svc, w.perm);
    const state = w.stateOf(w.svc.start("wsA", "u_owner").url);
    const res = fakeRes();
    await ctrl.callback("CODE-secret-1", state, undefined, res as never);
    expect(res.redirect).toHaveBeenCalledTimes(1);
    const [status, location] = res.redirect.mock.calls[0];
    expect(status).toBe(302);
    expect(location).toBe("https://app.example.com/#/ads?tab=connection&metaAds=choose");
    for (const secret of ["CODE-secret-1", state, ADS_TOKEN]) expect(location).not.toContain(secret);
  });

  it("a refused callback is still a 302, with an error key", async () => {
    const w = world();
    const res = fakeRes();
    await new MetaAdsController(w.svc, w.perm).callback("CODE-2", "not-a-state", undefined, res as never);
    expect(res.redirect).toHaveBeenCalledWith(302, "https://app.example.com/#/ads?tab=connection&metaAds=error&code=invalid_state");
  });
});
