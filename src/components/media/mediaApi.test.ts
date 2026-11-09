import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, setUnauthorizedHandler, tokenStore } from "@/api/client";
import { makeTx } from "@/lib/tx";
import { fetchMediaPage } from "./mediaApi";
import { mediaLibraryBlocked, mediaNoAccessText } from "./mediaErrors";

const respond = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status, headers }));

beforeEach(() => tokenStore.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  setUnauthorizedHandler(null);
  tokenStore.clear();
});

describe("fetchMediaPage (SP-13 final review: gallery paging follows the client's session rules)", () => {
  it("a 401 on a request that carried a token fires the global logout hook, like api/client", async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    tokenStore.set("expired");
    vi.stubGlobal("fetch", respond(401, { statusCode: 401, message: "Unauthorized" }));
    const err = await fetchMediaPage("all", null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("a 401 without a token, or any other error, does not log out", async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    vi.stubGlobal("fetch", respond(401, { message: "Unauthorized" }));
    await expect(fetchMediaPage("all", null)).rejects.toBeInstanceOf(ApiError);
    tokenStore.set("tok");
    vi.stubGlobal("fetch", respond(403, { statusCode: 403, message: "Forbidden" }));
    const err = (await fetchMediaPage("image", null).catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(403);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("sends the token and reads the page and its cursor header", async () => {
    tokenStore.set("tok");
    const fetchMock = respond(200, [{ id: "m1" }], { "X-Media-Next-Before": "cur-1" });
    vi.stubGlobal("fetch", fetchMock);
    const page = await fetchMediaPage("document", "cur-0");
    expect(page).toEqual({ items: [{ id: "m1" }], nextBefore: "cur-1" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/media?kind=document");
    expect(url).toContain("before=cur-0");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });
});

describe("media library access (roles without conversations.view)", () => {
  it("is blocked without conversations.view, or when the server answers 403; other errors still show", () => {
    expect(mediaLibraryBlocked(false, null)).toBe(true);
    expect(mediaLibraryBlocked(true, new ApiError("Forbidden", 403))).toBe(true);
    expect(mediaLibraryBlocked(true, null)).toBe(false);
    expect(mediaLibraryBlocked(true, new ApiError("boom", 500))).toBe(false);
    expect(mediaLibraryBlocked(true, new Error("network"))).toBe(false);
  });

  it("has a no-access line in English and Arabic", () => {
    expect(mediaNoAccessText(makeTx("en"))).toMatch(/media library/i);
    expect(mediaNoAccessText(makeTx("ar"))).toMatch(/[؀-ۿ]/);
  });
});
