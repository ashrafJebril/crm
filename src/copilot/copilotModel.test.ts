import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { addRef, refCandidates, refsForBody, removeRef } from "./refs";
import { readApprovalMode, writeApprovalMode, MODE_LABELS, TAINT_RULE } from "./approvalMode";
import { renderMarkdownLite, safeLinkHref } from "./markdownLite";
import { checkAttachment } from "./attachmentsClient";
import { pageContextOf } from "./pageContext";
import { offerReplyDraft, takeReplyDraft } from "./replyDraft";
import { ATTACH_DOC_MAX_BYTES, ATTACH_IMAGE_MAX_BYTES, MAX_REFS } from "./copilotConstants";
import type { CopilotRef } from "@/lib/types";

const html = (t: string) => renderToStaticMarkup(renderMarkdownLite(t) as never);

describe("refs picker caps at five and dedupes", () => {
  it("candidates from the gated searches, without the ones already chosen", () => {
    const c = refCandidates(
      { contacts: [{ id: "c1", name: "Layla", phone: "+9665" }, { id: "c1", name: "Layla" }], tickets: [{ id: "t1", number: 7, title: "Refund", stageLabel: "New" }] },
      [{ id: "b1", startAt: "2026-11-18T09:00:00.000Z", contactName: "Layla", service: "Cut", serviceAr: "قص" }],
      [{ kind: "ticket", id: "t1" }],
      "ar",
    );
    expect(c).toEqual([
      { kind: "contact", id: "c1", title: "Layla", subtitle: "+9665" },
      { kind: "booking", id: "b1", title: "قص · Layla", subtitle: "2026-11-18 09:00" },
    ]);
    expect(refCandidates(null, undefined, [])).toEqual([]);
  });

  it("at most five, no duplicates; the body carries kind and id only", () => {
    let s: CopilotRef[] = [];
    for (let i = 0; i < 8; i++) s = addRef(s, { kind: "contact", id: `c${i}`, title: `C${i}` });
    expect(s).toHaveLength(MAX_REFS);
    expect(addRef(s.slice(0, 2), { kind: "contact", id: "c0" })).toHaveLength(2);
    expect(removeRef(s, { kind: "contact", id: "c0" }).map((r) => r.id)).toEqual(["c1", "c2", "c3", "c4"]);
    expect(refsForBody(s)[0]).toEqual({ kind: "contact", id: "c0" });
  });
});

describe("approval mode defaults to manual and survives a blocked storage", () => {
  it("per member, validated, wrapped", () => {
    const mem = new Map<string, string>();
    const st = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    expect(readApprovalMode("u1", st)).toBe("manual");
    writeApprovalMode("u1", "auto", st);
    expect(readApprovalMode("u1", st)).toBe("auto");
    expect(readApprovalMode("u2", st)).toBe("manual");
    mem.set([...mem.keys()][0], "yolo");
    expect(readApprovalMode("u1", st)).toBe("manual");
    const blocked = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(readApprovalMode("u1", blocked)).toBe("manual");
    expect(() => writeApprovalMode("u1", "auto", blocked)).not.toThrow();
    expect(readApprovalMode(null, st)).toBe("manual");
    expect(readApprovalMode("u1", null)).toBe("manual");
    // The copy says it plainly.
    expect(MODE_LABELS.manual[0]).toBe("Confirm every change");
    expect(TAINT_RULE[0]).toMatch(/customer data, every change asks you first/);
  });
});

describe("markdown lite renders only the allowed subset", () => {
  it("paragraphs, breaks, lists, bold and safe links", () => {
    expect(html("Hi **there**\nline two\n\n- one\n- [Open](#/inbox?record=conversation:v1)\n\n1. a\n2. b")).toBe(
      '<p>Hi <strong>there</strong><br/>line two</p><ul><li>one</li><li><a href="#/inbox?record=conversation:v1" title="#/inbox?record=conversation:v1">Open</a></li></ul><ol><li>a</li><li>b</li></ol>',
    );
    expect(html("See https://kewy.ai/help.")).toBe('<p>See <a href="https://kewy.ai/help" title="https://kewy.ai/help" target="_blank" rel="noopener noreferrer">https://kewy.ai/help</a>.</p>');
  });

  it("never renders HTML or unsafe links", () => {
    expect(html('<img src=x onerror=alert(1)><script>alert(1)</script>')).toBe("<p>&lt;img src=x onerror=alert(1)&gt;&lt;script&gt;alert(1)&lt;/script&gt;</p>");
    expect(html("[click](javascript:alert(1))")).not.toContain("<a");
    expect(html("[x](data:text/html,hi)")).not.toContain("<a");
    expect(html("[x](//evil.example)")).not.toContain("<a");
    expect(html("# Heading\n> quote\n`code`")).toBe("<p># Heading<br/>&gt; quote<br/>`code`</p>");
    // https only.
    expect(safeLinkHref("http://x.example/a")).toBeNull();
    expect(html("See http://x.example/a and [x](http://x.example/b)")).not.toContain("<a");
    expect(safeLinkHref("https://x.example/a")).toBe("https://x.example/a");
    expect(safeLinkHref("mailto:a@b.c")).toBeNull();
    // In-app links: known routes only, and only a record target as their query.
    expect(safeLinkHref("#/pipeline")).toBe("#/pipeline");
    expect(safeLinkHref("#/contacts?record=contact:c1")).toBe("#/contacts?record=contact:c1");
    for (const bad of ["#/inbox?open=v1", "#/settings", "#/admin", "#/contacts?record=contact:c1&x=1", "#/contacts?record=user:u1", "#/unknown", "#settings"]) {
      expect({ bad, href: safeLinkHref(bad) }).toEqual({ bad, href: null });
    }
    expect(html("[Billing](#/settings?tab=billing)")).not.toContain("<a");
  });
});

describe("attachment checks mirror the backend", () => {
  it("types, sizes and count", () => {
    expect(checkAttachment({ name: "a.PDF", size: 10 }, 0)).toEqual({ ok: true, kind: "document" });
    expect(checkAttachment({ name: "p.webp", size: 10 }, 4)).toEqual({ ok: true, kind: "image" });
    expect(checkAttachment({ name: "p.png", size: 10 }, 5)).toMatchObject({ ok: false, key: "copilot.too_many_attachments" });
    expect(checkAttachment({ name: "a.docx", size: 10 }, 0)).toMatchObject({ ok: false, key: "copilot.attachment_type" });
    expect(checkAttachment({ name: "a.txt", size: 0 }, 0)).toMatchObject({ ok: false, key: "copilot.attachment_type" });
    expect(checkAttachment({ name: "p.jpg", size: ATTACH_IMAGE_MAX_BYTES + 1 }, 0)).toEqual({ ok: false, key: "copilot.attachment_too_large", extra: { maxBytes: ATTACH_IMAGE_MAX_BYTES } });
    expect(checkAttachment({ name: "d.pdf", size: ATTACH_DOC_MAX_BYTES }, 0).ok).toBe(true);
    expect(checkAttachment({ name: "d.xlsx", size: ATTACH_DOC_MAX_BYTES + 1 }, 0)).toMatchObject({ ok: false, key: "copilot.attachment_too_large" });
  });
});

describe("page context", () => {
  it("routes and records → page key and ids, never numbers", () => {
    expect(pageContextOf("dashboard", "#/dashboard")).toEqual({ page: "dashboard" });
    expect(pageContextOf("inbox", "#/inbox?open=v1")).toEqual({ page: "conversation", recordKind: "conversation", recordId: "v1" });
    expect(pageContextOf("inbox", "#/inbox?open=t_123")).toEqual({ page: "inbox" });
    expect(pageContextOf("contacts", "#/contacts?record=contact:c1")).toEqual({ page: "contact", recordKind: "contact", recordId: "c1" });
    expect(pageContextOf("pipeline", "#/pipeline?open=t1")).toEqual({ page: "ticket", recordKind: "ticket", recordId: "t1" });
    expect(pageContextOf("analytics", "#/analytics?tab=support&range=custom&from=2026-11-01&to=2026-11-10&channel=ch1")).toEqual({
      page: "insights_support",
      from: "2026-11-01",
      to: "2026-11-10",
      channelId: "ch1",
    });
    expect(pageContextOf("analytics", "#/analytics?tab=sales&pipeline=p1")).toEqual({ page: "insights_sales", pipelineId: "p1" });
    expect(pageContextOf("settings", "#/settings")).toEqual({ page: "other" });
  });
});

describe("copy to reply box", () => {
  it("is taken once, by its conversation only, and goes stale", () => {
    offerReplyDraft("v1", "Hello Layla", 1000);
    expect(takeReplyDraft("v2", 1000)).toBeNull();
    expect(takeReplyDraft("v1", 2000)).toBe("Hello Layla");
    expect(takeReplyDraft("v1", 2000)).toBeNull();
    offerReplyDraft("v1", "Old", 0);
    expect(takeReplyDraft("v1", 11 * 60 * 1000)).toBeNull();
  });
});
