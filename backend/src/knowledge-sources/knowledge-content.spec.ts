import { tiptapToText } from "./knowledge-content";
import { KNOWLEDGE_CONTENT_MAX } from "./knowledge-constants";

const doc = (...content: unknown[]) => ({ type: "doc", content });
const p = (...content: unknown[]) => ({ type: "paragraph", content });
const t = (text: string, marks?: unknown[]) => (marks ? { type: "text", text, marks } : { type: "text", text });
const h = (level: number, text: string) => ({ type: "heading", attrs: { level }, content: [t(text)] });

function refusal(fn: () => unknown) {
  try {
    fn();
  } catch (e: any) {
    return { status: e.getStatus(), body: e.getResponse() };
  }
  throw new Error("expected a refusal");
}

describe("knowledge content", () => {
  it("content accepts only allow-listed tiptap nodes", () => {
    const bad: [string, unknown][] = [
      ["script-shaped node", doc({ type: "script", content: [t("alert(1)")] })],
      ["html node", doc({ type: "html", attrs: { html: "<script>alert(1)</script>" } })],
      ["image node", doc({ type: "image", attrs: { src: "https://x.example/a.png" } })],
      ["javascript: link", doc(p(t("click", [{ type: "link", attrs: { href: "javascript:alert(1)" } }])))],
      ["data: link", doc(p(t("click", [{ type: "link", attrs: { href: "data:text/html,<b>x</b>" } }])))],
      ["http link", doc(p(t("x", [{ type: "link", attrs: { href: "http://example.com" } }])))],
      ["unknown mark", doc(p(t("x", [{ type: "code" }])))],
      ["onclick attr", doc({ type: "paragraph", attrs: { onclick: "x()" }, content: [t("x")] })],
      ["heading level 4", doc(h(4, "Deep"))],
      ["not a doc", p(t("x"))],
      ["text at top level", doc(t("x"))],
      ["object attr value", doc({ type: "paragraph", attrs: { textAlign: { evil: 1 } }, content: [t("x")] })],
      ["list item outside a list", doc({ type: "listItem", content: [p(t("x"))] })],
      ["non-array content", doc({ type: "paragraph", content: "x" })],
      ["string", "<p>hi</p>"],
    ];
    for (const [name, d] of bad) {
      expect({ name, ...refusal(() => tiptapToText(d)) }).toEqual({
        name,
        status: 400,
        body: { statusCode: 400, message: "knowledge.content_invalid" },
      });
    }

    const text = tiptapToText(
      doc(
        h(1, "About us"),
        p(t("We are a "), t("salon", [{ type: "bold" }]), t(" in Riyadh.")),
        h(2, "Contact"),
        p(t("Email "), t("us", [{ type: "link", attrs: { href: "mailto:hi@example.com" } }])),
        { type: "bulletList", content: [{ type: "listItem", content: [p(t("Open daily"))] }, { type: "listItem", content: [p(t("Free parking"))] }] },
        { type: "orderedList", attrs: { start: 1 }, content: [{ type: "listItem", content: [p(t("Book"))] }] },
        p(t("Site", [{ type: "link", attrs: { href: "https://example.com/" } }])),
      ),
    );
    expect(text).toBe(
      [
        "# About us",
        "We are a salon in Riyadh.",
        "## Contact",
        "Email us (mailto:hi@example.com)",
        "- Open daily",
        "- Free parking",
        "1. Book",
        "Site (https://example.com/)",
      ].join("\n\n"),
    );
    expect(text).not.toMatch(/<[a-z]/i);
    expect(tiptapToText(doc())).toBe("");
  });

  it("derived text over the cap is content_too_long", () => {
    const big = doc(p(t("x".repeat(KNOWLEDGE_CONTENT_MAX + 1))));
    expect(refusal(() => tiptapToText(big))).toEqual({
      status: 400,
      body: { statusCode: 400, message: "knowledge.content_too_long", max: KNOWLEDGE_CONTENT_MAX },
    });
  });
});
