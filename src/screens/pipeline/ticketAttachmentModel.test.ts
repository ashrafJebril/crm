import { describe, expect, it } from "vitest";
import { makeTx } from "@/lib/tx";
import type { TicketAttachment, TicketAttachmentCandidate } from "@/lib/types";
import {
  attachmentCapacity,
  attachmentFetchUrl,
  attachmentRows,
  pendingCandidates,
  withAttachment,
  withoutAttachment,
} from "./ticketAttachmentModel";

const en = makeTx("en");
const ar = makeTx("ar");

const att = (over: Partial<TicketAttachment>): TicketAttachment => ({
  id: "a1",
  ticketId: "t1",
  mediaId: "m1",
  source: "staff",
  fileName: "invoice.pdf",
  mimeType: "application/pdf",
  sizeBytes: 1536,
  messageId: null,
  addedBy: { id: "u1", name: "Sara" },
  createdAt: "2026-11-16T08:00:00.000Z",
  url: "/api/tickets/t1/attachments/a1",
  ...over,
});
const cand = (mediaId: string): TicketAttachmentCandidate => ({
  mediaId,
  messageId: `msg-${mediaId}`,
  fileName: `${mediaId}.jpg`,
  mimeType: "image/jpeg",
  sizeBytes: 2048,
  at: "2026-11-16T07:00:00.000Z",
});

describe("ticket attachment list model", () => {
  it("resolves the streamed route against the API base and refuses anything else", () => {
    expect(attachmentFetchUrl("/api/tickets/t1/attachments/a1", "https://crm.example.com/api")).toBe(
      "https://crm.example.com/api/tickets/t1/attachments/a1",
    );
    expect(attachmentFetchUrl("/api/tickets/t1/attachments/a1", "http://localhost:4100/api/")).toBe(
      "http://localhost:4100/api/tickets/t1/attachments/a1",
    );
    expect(attachmentFetchUrl("/tickets/t1/attachments/a1", "http://localhost:4100/api")).toBe(
      "http://localhost:4100/api/tickets/t1/attachments/a1",
    );
    // Never send the token elsewhere.
    expect(attachmentFetchUrl("https://bucket.example.com/x.png", "http://localhost:4100/api")).toBeNull();
    expect(attachmentFetchUrl("relative/x", "http://localhost:4100/api")).toBeNull();
  });

  it("rows are newest first with size, kind and a bilingual source", () => {
    const rows = attachmentRows(
      [
        att({ id: "old", createdAt: "2026-11-15T08:00:00.000Z" }),
        att({ id: "new", mediaId: "m2", source: "customer", fileName: "صورة.jpg", mimeType: "image/jpeg", sizeBytes: 3 * 1024 * 1024, addedBy: null }),
      ],
      en,
    );
    expect(rows.map((r) => r.id)).toEqual(["new", "old"]);
    expect(rows[0]).toMatchObject({ isImage: true, size: "3 MB", sourceLabel: "Customer", addedBy: null, fileName: "صورة.jpg" });
    expect(rows[1]).toMatchObject({ isImage: false, size: "2 KB", sourceLabel: "Team", addedBy: "Sara" });
    const arRows = attachmentRows([att({ source: "customer" }), att({ id: "a2", mediaId: "m2", source: "staff" })], ar);
    expect(arRows.map((r) => r.sourceLabel).sort()).toEqual(["العميل", "الفريق"].sort());
    expect(attachmentRows([att({ fileName: "" })], ar)[0].fileName).toBe("ملف بلا اسم");
  });

  it("candidates hide files already on the ticket", () => {
    expect(pendingCandidates([cand("m1"), cand("m2"), cand("m3")], [att({ mediaId: "m2" })]).map((c) => c.mediaId)).toEqual(["m1", "m3"]);
    expect(pendingCandidates([], [])).toEqual([]);
  });

  it("capacity follows the 50-file cap", () => {
    expect(attachmentCapacity(0)).toEqual({ full: false, left: 50 });
    expect(attachmentCapacity(49)).toEqual({ full: false, left: 1 });
    expect(attachmentCapacity(50)).toEqual({ full: true, left: 0 });
    expect(attachmentCapacity(70)).toEqual({ full: true, left: 0 });
  });

  it("cache updates insert on top without duplicates and remove by id", () => {
    const list = [att({ id: "a1", mediaId: "m1" }), att({ id: "a2", mediaId: "m2" })];
    const added = withAttachment(list, att({ id: "a3", mediaId: "m3" }));
    expect(added.map((a) => a.id)).toEqual(["a3", "a1", "a2"]);
    expect(withAttachment(added, att({ id: "a3", mediaId: "m3" })).map((a) => a.id)).toEqual(["a3", "a1", "a2"]);
    expect(withoutAttachment(added, "a1").map((a) => a.id)).toEqual(["a3", "a2"]);
    expect(withoutAttachment(added, "missing")).toHaveLength(3);
  });
});
