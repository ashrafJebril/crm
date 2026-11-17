import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { Campaign } from "@/lib/types";
import { campaignPollMs } from "@/screens/campaigns/campaignDetailModel";
import { resolvePollMs, useFetch } from "./useFetch";

describe("resolvePollMs", () => {
  it("accepts a number, and treats missing or non-positive as no polling", () => {
    expect(resolvePollMs(5000, undefined)).toBe(5000);
    expect(resolvePollMs(undefined, undefined)).toBe(false);
    expect(resolvePollMs(0, undefined)).toBe(false);
  });

  it("reads the interval from the latest data, so a launch polls on its first response", () => {
    const pollMs = (c: Pick<Campaign, "status" | "launchedAt" | "scheduledAt"> | null | undefined) =>
      campaignPollMs(c ?? null, Date.now());
    // Nothing fetched yet: no polling. The very next result decides, with no render in between.
    expect(resolvePollMs(pollMs, undefined)).toBe(false);
    const launching = { status: "launching" as const, launchedAt: null, scheduledAt: null };
    expect(resolvePollMs(pollMs, launching)).toBeGreaterThan(0);
    expect(resolvePollMs(pollMs, { ...launching, status: "failed" })).toBe(false);
  });
});

type State<T> = ReturnType<typeof useFetch<T>>;

/** Renders one `useFetch` call against `client` and returns what the hook returned. */
function hook<T>(client: QueryClient, path: string | null): State<T> {
  let out: State<T> | undefined;
  function Probe() {
    out = useFetch<T>(path);
    return null;
  }
  renderToString(createElement(QueryClientProvider, { client }, createElement(Probe)));
  return out as State<T>;
}

describe("useFetch disabled queries (SP-10 live fix F2)", () => {
  it("a disabled query's setData never leaks into another disabled query's data", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // The catalog wizard: setData while its job query is still disabled.
    const wizard = hook<{ id: string; status: string }>(client, null);
    wizard.setData({ id: "job-1", status: "extracting" });
    // The shell's not-connected Facebook/Instagram hooks: they iterate their data.
    const shell = hook<string[]>(client, null);
    expect(shell.data).toBeNull();
    expect(() => [...(shell.data ?? [])]).not.toThrow();
    // Nothing was written anywhere.
    expect(client.getQueryCache().getAll().every((q) => q.state.data === undefined)).toBe(true);
  });

  it("two disabled hooks never share a cache key", () => {
    const client = new QueryClient();
    hook(client, null);
    hook(client, null);
    const keys = client.getQueryCache().getAll().map((q) => JSON.stringify(q.queryKey));
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  it("an enabled query's setData still patches its own key", () => {
    const client = new QueryClient();
    const q = hook<{ n: number }>(client, "/things");
    q.setData({ n: 1 });
    expect(client.getQueryData(["/things"])).toEqual({ n: 1 });
    q.setData((p) => ({ n: (p?.n ?? 0) + 1 }));
    expect(client.getQueryData(["/things"])).toEqual({ n: 2 });
  });
});
