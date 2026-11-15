import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { TICKET_ERROR_KEYS, TICKET_ERROR_STATUS, ticketError } from "./ticket-errors";

describe("SP-09 ticket error keys", () => {
  it("every key in Global Constraints, with its status", () => {
    expect(TICKET_ERROR_STATUS).toEqual({
      "tickets.invalid_priority": 400,
      "tickets.invalid_category": 400,
      "tickets.attachments_full": 400,
      "tickets.no_conversation": 400,
      "tickets.attachment_not_found": 404,
      "tickets.attachment_source_not_found": 404,
      "tickets.attachment_exists": 409,
      "tickets.no_resolved_stage": 409,
      "tickets.already_closed": 409,
    });
  });

  it("the body is {statusCode, message: key, ...extra} with the matching exception class", () => {
    for (const key of TICKET_ERROR_KEYS) {
      const e = ticketError(key, { limit: 50 });
      const status = TICKET_ERROR_STATUS[key];
      expect(e.getStatus()).toBe(status);
      expect(e.getResponse()).toEqual({ statusCode: status, message: key, limit: 50 });
      const cls = status === 404 ? NotFoundException : status === 409 ? ConflictException : BadRequestException;
      expect(e).toBeInstanceOf(cls);
    }
  });
});
