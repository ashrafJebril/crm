import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scheduleSeen, type VisibilityDoc } from "./seenTimer";

function fakeDoc(state: "visible" | "hidden") {
  let cb: (() => void) | null = null;
  const doc = {
    visibilityState: state as string,
    addEventListener: (_t: "visibilitychange", f: () => void) => {
      cb = f;
    },
    removeEventListener: () => {
      cb = null;
    },
  };
  const set = (s: "visible" | "hidden") => {
    doc.visibilityState = s;
    cb?.();
  };
  return { doc: doc as VisibilityDoc, set, listening: () => cb !== null };
}

describe("home seen timer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires after 3 s on screen, once", () => {
    const { doc } = fakeDoc("visible");
    let fired = 0;
    scheduleSeen(doc, 3000, () => fired > 0, () => (fired += 1));
    vi.advanceTimersByTime(2999);
    expect(fired).toBe(0);
    vi.advanceTimersByTime(1);
    expect(fired).toBe(1);
    vi.advanceTimersByTime(10_000);
    expect(fired).toBe(1);
  });

  it("re-arms when a hidden tab becomes visible, and still fires at most once", () => {
    const { doc, set } = fakeDoc("hidden");
    let fired = 0;
    const cancel = scheduleSeen(doc, 3000, () => fired > 0, () => (fired += 1));
    vi.advanceTimersByTime(5000);
    expect(fired).toBe(0); // hidden the whole time
    set("visible");
    vi.advanceTimersByTime(1500);
    set("hidden"); // interrupted: the countdown is dropped
    vi.advanceTimersByTime(5000);
    expect(fired).toBe(0);
    set("visible");
    vi.advanceTimersByTime(3000);
    expect(fired).toBe(1);
    set("hidden");
    set("visible");
    vi.advanceTimersByTime(10_000);
    expect(fired).toBe(1);
    cancel();
  });

  it("cancel stops the timer and the listener", () => {
    const { doc, listening } = fakeDoc("visible");
    let fired = 0;
    const cancel = scheduleSeen(doc, 3000, () => false, () => (fired += 1));
    cancel();
    vi.advanceTimersByTime(5000);
    expect(fired).toBe(0);
    expect(listening()).toBe(false);
  });
});
