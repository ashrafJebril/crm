import { describe, expect, it } from "vitest";
import { zernioRedirectTarget } from "./zernioRedirect";

describe("zernioRedirectTarget (m4)", () => {
  const hub = "#/channels?zernio=connected&platform=whatsapp";
  it("sends members without channels.view to Settings with the same params", () => {
    expect(zernioRedirectTarget(hub, false)).toBe("#/settings?zernio=connected&platform=whatsapp");
    expect(zernioRedirectTarget("#channels?zernio=connected", false)).toBe("#/settings?zernio=connected");
  });
  it("leaves the hub alone for channels.view holders", () => {
    expect(zernioRedirectTarget(hub, true)).toBeNull();
  });
  it("ignores other routes and hashes without the Zernio callback", () => {
    expect(zernioRedirectTarget("#/settings?zernio=connected&platform=facebook", false)).toBeNull();
    expect(zernioRedirectTarget("#/channels?id=c1", false)).toBeNull();
    expect(zernioRedirectTarget("#/channels", false)).toBeNull();
    expect(zernioRedirectTarget("", false)).toBeNull();
  });
});
