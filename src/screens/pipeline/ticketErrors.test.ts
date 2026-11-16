import { describe, expect, it } from "vitest";
import { ApiError } from "@/api/client";
import { makeTx } from "@/lib/tx";
// The backend key list is the fixture (read as text; never compiled here).
import backendErrors from "../../../backend/src/tickets/ticket-errors.ts?raw";
import { TICKET_ERROR_COPY, ticketErrorText } from "./ticketErrors";

const en = makeTx("en");
const ar = makeTx("ar");
const ARABIC = /[؀-ۿ]/;

function backendKeys(): string[] {
  const m = /TICKET_ERROR_STATUS[^=]*=\s*\{([^}]*)\}/.exec(backendErrors);
  if (!m) throw new Error("TICKET_ERROR_STATUS not found");
  return [...m[1].matchAll(/"(tickets\.[a-z_]+)"/g)].map((x) => x[1]);
}

describe("ticketErrorText", () => {
  it("ticket error copy covers every SP-09 key in both languages", () => {
    const keys = backendKeys();
    expect(keys).toHaveLength(10);
    expect(Object.keys(TICKET_ERROR_COPY).filter((k) => k.startsWith("tickets.")).sort()).toEqual([...keys].sort());
    const arSeen = new Set<string>();
    for (const key of keys) {
      // Service shape: {message: key}.
      const err = new ApiError(key, 400, undefined, { statusCode: 400, message: key });
      const e = ticketErrorText(err, en);
      const a = ticketErrorText(err, ar);
      expect(e, key).not.toBe(key);
      expect(e, key).not.toMatch(ARABIC);
      expect(e, key).not.toMatch(/Something went wrong/);
      expect(a, key).toMatch(ARABIC);
      arSeen.add(a);
    }
    expect(arSeen.size).toBe(keys.length);
  });

  it("reads the ValidationPipe array shape and the limit extra", () => {
    // ApiError joins `message: [key]` arrays with ", ".
    const v = new ApiError("tickets.invalid_priority", 400, undefined, { message: ["tickets.invalid_priority"] });
    expect(ticketErrorText(v, en)).toBe("Choose a priority from the list.");
    const full = new ApiError("tickets.attachments_full", 400, undefined, { message: "tickets.attachments_full", limit: 50 });
    expect(ticketErrorText(full, en)).toContain("50 files");
    expect(ticketErrorText(full, ar)).toContain("50");
  });

  it("words SP-13 upload keys, a 403 and unknown errors", () => {
    const tooLarge = new ApiError("media.too_large", 400, undefined, { message: "media.too_large", limit: 20 * 1024 * 1024 });
    expect(ticketErrorText(tooLarge, en)).toBe("That file is too large. The limit for this type is 20 MB.");
    expect(ticketErrorText(new ApiError("Missing permission: tickets.update", 403), en)).toBe("You don't have permission to do this");
    expect(ticketErrorText(new ApiError("tickets.not_closed", 409), en)).toBe("This card is not closed.");
    expect(ticketErrorText(new Error("HTTP 500"), en, "Upload failed")).toBe("Upload failed");
    expect(ticketErrorText(new Error("HTTP 500"), ar)).toMatch(ARABIC);
    expect(ticketErrorText(new ApiError("Ticket not found", 404), en)).toBe("This ticket no longer exists.");
  });
});
