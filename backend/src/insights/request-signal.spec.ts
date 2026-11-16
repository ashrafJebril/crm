import { EventEmitter } from "events";
import { requestAbortSignal } from "./request-signal";

describe("requestAbortSignal", () => {
  it("aborts when the response closes unfinished, not after a normal finish", () => {
    const gone = Object.assign(new EventEmitter(), { writableFinished: false });
    const s1 = requestAbortSignal(gone);
    expect(s1.aborted).toBe(false);
    gone.emit("close");
    expect(s1.aborted).toBe(true);

    const done = Object.assign(new EventEmitter(), { writableFinished: true });
    const s2 = requestAbortSignal(done);
    done.emit("close");
    expect(s2.aborted).toBe(false);
  });
});
