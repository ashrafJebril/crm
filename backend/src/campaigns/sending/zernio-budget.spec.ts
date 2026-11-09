import { HttpException } from "@nestjs/common";
import { ZernioRateLimitError } from "../../integrations/zernio.client";
import { campaignDirectRpm, TokenBucket, withRetryAfter, ZernioBudget, zernioCampaignRpm } from "./zernio-budget";

/** A virtual clock: sleeping advances time instantly. */
function clock(start = 0) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
    advance: (ms: number) => (t += ms),
  };
}

describe("zernio budget throttles campaign calls and honours Retry-After", () => {
  it("reads ZERNIO_CAMPAIGN_RPM (300) and CAMPAIGN_DIRECT_RPM (120), positive integers only", () => {
    expect(zernioCampaignRpm({})).toBe(300);
    expect(campaignDirectRpm({})).toBe(120);
    expect(zernioCampaignRpm({ ZERNIO_CAMPAIGN_RPM: "600" })).toBe(600);
    expect(campaignDirectRpm({ CAMPAIGN_DIRECT_RPM: "60" })).toBe(60);
    expect(zernioCampaignRpm({ ZERNIO_CAMPAIGN_RPM: "-1" })).toBe(300);
    expect(campaignDirectRpm({ CAMPAIGN_DIRECT_RPM: "abc" })).toBe(120);
  });

  it("a bucket of N per minute admits at most N calls in any minute (after its burst)", async () => {
    const c = clock();
    const bucket = new TokenBucket(60, c, 1); // one per second, no burst
    const times: number[] = [];
    for (let i = 0; i < 10; i++) {
      await bucket.take();
      times.push(c.now());
    }
    expect(times).toEqual([0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000]);
  });

  it("allows a small burst, then paces", async () => {
    const c = clock();
    const bucket = new TokenBucket(300, c, 5); // 200 ms interval, burst 5
    const times: number[] = [];
    for (let i = 0; i < 8; i++) {
      await bucket.take();
      times.push(c.now());
    }
    expect(times.slice(0, 5)).toEqual([0, 0, 0, 0, 0]);
    expect(times.slice(5)).toEqual([200, 400, 600]);
    // 300 calls never take less than (300 - burst) * 200 ms.
    const c2 = clock();
    const b2 = new TokenBucket(300, c2, 5);
    for (let i = 0; i < 300; i++) await b2.take();
    expect(c2.now()).toBeGreaterThanOrEqual(295 * 200);
  });

  it("idle time refills only up to the burst", async () => {
    const c = clock();
    const bucket = new TokenBucket(60, c, 2);
    await bucket.take();
    await bucket.take();
    c.advance(60_000);
    const t0 = c.now();
    await bucket.take();
    await bucket.take();
    expect(c.now()).toBe(t0);
    await bucket.take();
    expect(c.now()).toBe(t0 + 1000);
  });

  it("the budget pairs a campaign bucket with a stricter direct bucket", async () => {
    const c = clock();
    const budget = new ZernioBudget({ ZERNIO_CAMPAIGN_RPM: "600", CAMPAIGN_DIRECT_RPM: "60" }, c);
    expect(budget.campaign.rpm).toBe(600);
    expect(budget.direct.rpm).toBe(60);
  });

  it("withRetryAfter waits Retry-After on a 429 and retries; other errors pass through", async () => {
    const c = clock();
    const before = jest.fn(async () => {});
    let n = 0;
    const res = await withRetryAfter(
      async () => {
        n++;
        if (n < 3) throw new ZernioRateLimitError("slow down", n === 1 ? 7000 : null);
        return "ok";
      },
      { sleep: c.sleep, before },
    );
    expect(res).toBe("ok");
    // 7 s from the header, then the default wait when Zernio sent none.
    expect(c.sleeps).toEqual([7000, 5000]);
    // The hook (budget token + lease fence) runs before every attempt.
    expect(before).toHaveBeenCalledTimes(3);

    await expect(withRetryAfter(async () => Promise.reject(new HttpException("bad", 400)), { sleep: c.sleep })).rejects.toThrow("bad");
  });

  it("caps each wait and gives up after maxRetries, rethrowing the 429", async () => {
    const c = clock();
    const err = await withRetryAfter(async () => Promise.reject(new ZernioRateLimitError("x", 600_000)), {
      sleep: c.sleep,
      maxRetries: 2,
      maxWaitMs: 60_000,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ZernioRateLimitError);
    expect(c.sleeps).toEqual([60_000, 60_000]);
  });
});
