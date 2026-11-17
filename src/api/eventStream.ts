/**
 * SP-18: an incremental Server-Sent Events parser (pure). Feed it decoded
 * text chunks as they arrive; it calls `onFrame` once per complete frame.
 *
 *  - Frames end at a blank line; CRLF and CR line ends are accepted.
 *  - `event:` names the frame (default "message"); several `data:` lines are
 *    joined with "\n" (the SSE rule); one leading space after the colon is dropped.
 *  - Comment lines (`:` heartbeats) and unknown fields are ignored.
 *  - A frame cut off by the end of the stream is dropped (never half-parsed).
 */
export interface SseFrame {
  event: string;
  data: string;
}

export function createSseParser(onFrame: (f: SseFrame) => void) {
  let buf = "";
  let held = "";
  const flushFrame = (raw: string) => {
    let event = "message";
    const data: string[] = [];
    let any = false;
    for (const line of raw.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const i = line.indexOf(":");
      const field = i === -1 ? line : line.slice(0, i);
      let value = i === -1 ? "" : line.slice(i + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") {
        event = value;
        any = true;
      } else if (field === "data") {
        data.push(value);
        any = true;
      }
    }
    if (any && data.length) onFrame({ event, data: data.join("\n") });
  };
  return {
    push(chunk: string) {
      // A chunk may end between "\r" and "\n": hold a trailing "\r" back for the next one.
      let raw = held + chunk;
      held = "";
      if (raw.endsWith("\r")) {
        held = "\r";
        raw = raw.slice(0, -1);
      }
      buf += raw.replace(/\r\n?/g, "\n");
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        flushFrame(frame);
      }
    },
    /** The stream ended: anything left is an incomplete frame and is dropped. */
    end() {
      buf = "";
      held = "";
    },
  };
}

/** The terminal events of a copilot stream: every stream ends with one of them. */
export const TERMINAL_EVENTS: ReadonlySet<string> = new Set(["done", "error"]);
/** The synthetic error a stream gets when it is cut before done/error. */
export const STREAM_LOST = "copilot.stream_lost";
