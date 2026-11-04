import { describe, expect, it } from "vitest";
import { feedState } from "./feedState";

const base = {
  statusLoaded: true,
  statusError: null,
  connected: true,
  postsLoaded: true,
  postsError: null,
};

describe("feedState", () => {
  it("is 'checking' while the connection status has not arrived yet", () => {
    expect(feedState({ ...base, statusLoaded: false, connected: false, postsLoaded: false })).toBe("checking");
  });

  it("only reports 'disconnected' once the status has actually loaded", () => {
    expect(feedState({ ...base, connected: false, postsLoaded: false })).toBe("disconnected");
  });

  it("is 'loading' while a connected account's posts are still on the way", () => {
    expect(feedState({ ...base, postsLoaded: false })).toBe("loading");
  });

  it("is 'ready' once the posts are in", () => {
    expect(feedState(base)).toBe("ready");
  });

  it("surfaces a failed status check instead of claiming the account is disconnected", () => {
    expect(feedState({ ...base, statusLoaded: false, statusError: "Network error", connected: false, postsLoaded: false })).toBe(
      "status-error",
    );
  });

  it("stops loading when the posts request fails", () => {
    expect(feedState({ ...base, postsLoaded: false, postsError: "Zernio 502" })).toBe("posts-error");
  });
});
