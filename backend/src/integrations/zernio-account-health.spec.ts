import { accountHealth } from "./zernio-account-health";

const ok = { _id: "a1", platform: "whatsapp", isActive: true, platformStatus: "active", needsReconnection: false, metadata: {} };

describe("accountHealth", () => {
  it("is ok for an active account", () => {
    expect(accountHealth(ok)).toEqual({ health: "ok", reason: null });
  });

  it("flags an account Meta removed, with the date", () => {
    const h = accountHealth({ ...ok, isActive: false, metadata: { metaDeletedAt: "2026-09-14T02:17:55.493Z" } });
    expect(h.health).toBe("reconnect");
    expect(h.reason).toMatch(/Meta removed access on 2026-09-14/);
  });

  it("flags an expired sign-in", () => {
    expect(accountHealth({ ...ok, needsReconnection: true })).toEqual({
      health: "reconnect",
      reason: "The sign-in expired. Connect it again.",
    });
  });

  it("flags an inactive account", () => {
    expect(accountHealth({ ...ok, isActive: false }).health).toBe("reconnect");
  });

  it("flags a platform status other than active", () => {
    expect(accountHealth({ ...ok, platformStatus: "suspended" }).reason).toMatch(/suspended/);
  });

  it("flags an account Zernio no longer has", () => {
    expect(accountHealth(undefined)).toEqual({
      health: "reconnect",
      reason: "This account is no longer connected in Zernio. Connect it again.",
    });
  });
});
