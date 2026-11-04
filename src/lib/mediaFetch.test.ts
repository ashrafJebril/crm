import { describe, expect, it, vi } from "vitest";
import { createMediaFetcher, MediaFetchError } from "./mediaFetch";

const ok = () => new Response(new Blob(["img"]), { status: 200 });
const status = (s: number) => new Response("x", { status: s });
const noSleep = () => Promise.resolve();

describe("createMediaFetcher", () => {
  it("retries transient server errors and then succeeds", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(status(500)).mockResolvedValueOnce(status(503)).mockResolvedValueOnce(ok());
    const load = createMediaFetcher({ fetchFn, sleep: noSleep, retries: 3 });
    const blob = await load("/media/a/file", null);
    expect(await blob.text()).toBe("img");
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("retries network failures", async () => {
    const fetchFn = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(ok());
    const load = createMediaFetcher({ fetchFn, sleep: noSleep });
    await expect(load("/media/a/file", null)).resolves.toBeInstanceOf(Blob);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("does not retry a missing file", async () => {
    const fetchFn = vi.fn().mockResolvedValue(status(404));
    const load = createMediaFetcher({ fetchFn, sleep: noSleep });
    const err = await load("/media/a/file", null).catch((e) => e);
    expect(err).toBeInstanceOf(MediaFetchError);
    expect(err.status).toBe(404);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("gives up after the retry budget", async () => {
    const fetchFn = vi.fn().mockResolvedValue(status(500));
    const load = createMediaFetcher({ fetchFn, sleep: noSleep, retries: 2 });
    const err = await load("/media/a/file", null).catch((e) => e);
    expect(err.status).toBe(500);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("sends the bearer token", async () => {
    const fetchFn = vi.fn().mockResolvedValue(ok());
    await createMediaFetcher({ fetchFn, sleep: noSleep })("/media/a/file", "tok");
    expect(fetchFn.mock.calls[0][1].headers).toEqual({ Authorization: "Bearer tok" });
  });

  it("never runs more than `concurrency` requests at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchFn = vi.fn(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return ok();
    });
    const load = createMediaFetcher({ fetchFn, sleep: noSleep, concurrency: 3 });
    await Promise.all(Array.from({ length: 10 }, (_, i) => load(`/media/${i}/file`, null)));
    expect(fetchFn).toHaveBeenCalledTimes(10);
    expect(peak).toBe(3);
  });

  it("drops a queued request whose signal aborts before it starts", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchFn = vi.fn(async () => {
      await gate;
      return ok();
    });
    const load = createMediaFetcher({ fetchFn, sleep: noSleep, concurrency: 1 });
    const first = load("/media/1/file", null);
    const ctrl = new AbortController();
    const second = load("/media/2/file", null, ctrl.signal);
    ctrl.abort();
    release();
    await first;
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
