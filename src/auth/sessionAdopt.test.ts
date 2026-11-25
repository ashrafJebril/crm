import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "@/lib/types";
import { nextSessionNotice, pickActiveWorkspace } from "./sessionModel";

/**
 * SP-26 review I2/M6: adopting a new session (2FA on/off) reconnects the
 * realtime socket and keeps the workspace on screen.
 */
const reconnect = vi.fn(() => true);
vi.mock("@/api/realtime", () => ({
  reconnectSocket: () => reconnect(),
  ensureSocket: () => ({ disconnect: () => ({ connect: () => undefined }) }),
  disconnectSocket: () => undefined,
}));

const ws = (id: string): Workspace => ({ id, name: id, slug: id, role: "owner" }) as unknown as Workspace;

beforeEach(() => {
  const mem = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  });
  reconnect.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe("adoptSession reconnects realtime (2FA on/off ends the old socket for good)", () => {
  it("stores the new token and reconnects the socket", async () => {
    const { AuthProvider, useAuth } = await import("./context");
    const { tokenStore } = await import("@/api/client");
    let auth: ReturnType<typeof useAuth> | undefined;
    function Probe() {
      auth = useAuth();
      return null;
    }
    renderToString(createElement(AuthProvider, null, createElement(Probe)));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    auth!.adoptSession({
      token: "tok-new",
      user: { id: "u1", email: "a@x.test", name: "A", role: "member", initials: "A", color: "#000", twoFA: true },
      workspaces: [ws("w1")],
      activeWorkspaceId: "w1",
    });
    errors.mockRestore();
    expect(tokenStore.get()).toBe("tok-new");
    expect(reconnect).toHaveBeenCalledTimes(1);
  });
});

describe("the workspace on screen survives a reissued session", () => {
  it("keeps the current workspace while it is still valid", () => {
    const res = { workspaces: [ws("w1"), ws("w2")], activeWorkspaceId: "w1" };
    expect(pickActiveWorkspace("w2", res)?.id).toBe("w2");
    expect(pickActiveWorkspace("gone", res)?.id).toBe("w1");
    expect(pickActiveWorkspace(null, res)?.id).toBe("w1");
    expect(pickActiveWorkspace(null, { workspaces: [ws("w1")], activeWorkspaceId: "missing" })?.id).toBe("w1");
    expect(pickActiveWorkspace("w1", { workspaces: [], activeWorkspaceId: null })).toBeNull();
  });

  it("a later 401 never clears the session-expired notice", () => {
    expect(nextSessionNotice(null, "auth.session_expired")).toBe("session_expired");
    expect(nextSessionNotice("session_expired", undefined)).toBe("session_expired");
    expect(nextSessionNotice("session_expired", "Unauthorized")).toBe("session_expired");
    expect(nextSessionNotice(null, "Unauthorized")).toBeNull();
  });
});
