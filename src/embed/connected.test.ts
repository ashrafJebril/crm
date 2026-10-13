import { describe, expect, it, vi } from "vitest";
import { refreshAfterConnect } from "./connected";

function deps() {
  const calls: string[] = [];
  const post = vi.fn(async (path: string) => { calls.push(`post ${path}`); return {}; });
  const invalidate = vi.fn(() => { calls.push("invalidate"); });
  return { calls, post, invalidate };
}

describe("refreshAfterConnect", () => {
  it("zernio: syncs then invalidates", async () => {
    const d = deps();
    await refreshAfterConnect("zernio", d);
    expect(d.post).toHaveBeenCalledWith("/integrations/zernio/sync");
    expect(d.calls).toEqual(["post /integrations/zernio/sync", "invalidate"]);
  });

  it("zernio: still invalidates when the sync fails", async () => {
    const d = deps();
    d.post.mockRejectedValueOnce(new Error("boom"));
    await refreshAfterConnect("zernio", d);
    expect(d.invalidate).toHaveBeenCalledTimes(1);
  });

  it("other providers: invalidate only, no sync", async () => {
    const d = deps();
    await refreshAfterConnect("facebook", d);
    expect(d.post).not.toHaveBeenCalled();
    expect(d.invalidate).toHaveBeenCalledTimes(1);
  });
});
