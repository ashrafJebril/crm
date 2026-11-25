import { SlidingWindowLimiter } from "./rate-limit";

describe("SlidingWindowLimiter", () => {
  function clock(start = 1_000_000) {
    let t = start;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  }

  it("allows up to the limit within the window, then refuses with a retry-after", () => {
    const c = clock();
    const l = new SlidingWindowLimiter({ limit: 3, windowMs: 60_000, now: c.now });
    expect(l.hit("k").ok).toBe(true);
    c.advance(10_000);
    expect(l.hit("k").ok).toBe(true);
    expect(l.hit("k").ok).toBe(true);
    const r = l.hit("k");
    expect(r.ok).toBe(false);
    // The oldest hit leaves the window 50 s from now.
    expect(r.retryAfterSec).toBe(50);
  });

  it("slides: a hit frees up once the oldest one leaves the window", () => {
    const c = clock();
    const l = new SlidingWindowLimiter({ limit: 2, windowMs: 1_000, now: c.now });
    l.hit("k");
    c.advance(500);
    l.hit("k");
    expect(l.hit("k").ok).toBe(false);
    c.advance(501);
    expect(l.hit("k").ok).toBe(true);
    expect(l.hit("k").ok).toBe(false);
  });

  it("a refused hit does not count", () => {
    const c = clock();
    const l = new SlidingWindowLimiter({ limit: 1, windowMs: 1_000, now: c.now });
    l.hit("k");
    for (let i = 0; i < 5; i++) l.hit("k");
    c.advance(1_001);
    expect(l.hit("k").ok).toBe(true);
  });

  it("keys are independent", () => {
    const l = new SlidingWindowLimiter({ limit: 1, windowMs: 1_000, now: () => 0 });
    expect(l.hit("a").ok).toBe(true);
    expect(l.hit("b").ok).toBe(true);
    expect(l.hit("a").ok).toBe(false);
  });

  it("memory stays bounded: idle keys are pruned and the key count is capped", () => {
    const c = clock();
    const l = new SlidingWindowLimiter({ limit: 5, windowMs: 1_000, now: c.now, maxKeys: 100 });
    for (let i = 0; i < 1_000; i++) l.hit(`k${i}`);
    expect(l.size()).toBeLessThanOrEqual(100);
    c.advance(2_000);
    l.hit("fresh");
    expect(l.size()).toBe(1);
  });

  it("rejects a nonsensical configuration", () => {
    expect(() => new SlidingWindowLimiter({ limit: 0, windowMs: 1 })).toThrow();
    expect(() => new SlidingWindowLimiter({ limit: 1, windowMs: 0 })).toThrow();
  });
});
