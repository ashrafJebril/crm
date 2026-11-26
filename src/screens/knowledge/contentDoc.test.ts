import { describe, expect, it } from "vitest";
import { getSchema, type JSONContent } from "@tiptap/core";
import type { Node as PMNode, Schema } from "@tiptap/pm/model";
import { badLinks, knowledgeExtensions, safeLink, sanitizeDoc, upgradePastedLinks } from "./contentDoc";

/*
 * The content is checked on l (kewy-ai, app/knowledge/content.py). Its test
 * tests/knowledge/test_crm_editor_docs.py holds the documents built here
 * (fixtures/crm_editor_docs.json): the full one passes, and the http-link and
 * `title` ones are refused until sanitizeDoc cleans them. Change these
 * documents there too.
 */

/** Build a document through the editor's real schema (what `editor.getJSON()` returns is `doc.toJSON()`). */
function editorDoc(schema: Schema, build: (s: Schema) => PMNode): JSONContent {
  const doc = build(schema);
  doc.check(); // valid for this schema
  return doc.toJSON() as JSONContent;
}

describe("content editor JSON for the content validator on l", () => {
  const schema = getSchema(knowledgeExtensions());

  it("the editor's link, headings, lists and marks serialize as the validator expects", () => {
    const link = (href: string) => schema.marks.link.create({ href });
    const json = editorDoc(schema, (s) =>
      s.node("doc", null, [
        s.node("heading", { level: 1 }, [s.text("About us")]),
        s.node("paragraph", null, [
          s.text("We are a "),
          s.text("salon", [s.marks.bold.create()]),
          s.text(" in "),
          s.text("Riyadh", [s.marks.italic.create()]),
          s.text(". Book on "),
          s.text("our site", [link("https://example.com/book")]),
          s.text(" or "),
          s.text("email us", [link("mailto:hi@example.com")]),
          s.node("hardBreak"),
          s.text("Open daily."),
        ]),
        s.node("heading", { level: 3 }, [s.text("Services")]),
        s.node("bulletList", null, [
          s.node("listItem", null, [s.node("paragraph", null, [s.text("Haircut")])]),
          s.node("listItem", null, [s.node("paragraph", null, [s.text("Colour")])]),
        ]),
        s.node("orderedList", { start: 1 }, [s.node("listItem", null, [s.node("paragraph", null, [s.text("Book")])])]),
      ]),
    );
    // The serialized link carries no `title` (TipTap 3's default Link would add `title: null`).
    const linkMark = JSON.stringify(json).match(/"type":"link","attrs":\{[^}]*\}/)?.[0] ?? "";
    expect(linkMark).toContain('"href":"https://example.com/book"');
    expect(linkMark).not.toContain("title");
    // The pre-save sanitizer leaves a valid document unchanged.
    expect(sanitizeDoc(json)).toEqual(json);
    expect(badLinks(json)).toEqual([]);
  });

  it("the schema has only what the backend accepts", () => {
    expect(Object.keys(schema.nodes).sort()).toEqual(["bulletList", "doc", "hardBreak", "heading", "listItem", "orderedList", "paragraph", "text"].sort());
    expect(Object.keys(schema.marks).sort()).toEqual(["bold", "italic", "link"]);
    expect(Object.keys(schema.marks.link.spec.attrs ?? {}).sort()).toEqual(["class", "href", "rel", "target"]);
  });

  it("http links never reach the validator: refused, upgraded on paste, or dropped before saving", () => {
    expect(safeLink("http://example.com")).toBeNull();
    expect(safeLink("example.com")).toBe("https://example.com/");
    expect(safeLink("mailto:a@b.co")).toBe("mailto:a@b.co");
    expect(safeLink("javascript:alert(1)")).toBeNull();
    expect(upgradePastedLinks('<a href="http://shop.example/x">x</a> <a href=\'HTTP://a.b\'>y</a>')).toBe(
      '<a href="https://shop.example/x">x</a> <a href=\'https://a.b\'>y</a>',
    );
    // A stray http link (e.g. from stored content) is dropped, its text kept.
    const withHttp = editorDoc(schema, (s) =>
      s.node("doc", null, [s.node("paragraph", null, [s.text("old link", [s.marks.link.create({ href: "http://old.example" })])])]),
    );
    expect(badLinks(withHttp)).toEqual(["http://old.example"]);
    const clean = sanitizeDoc(withHttp);
    expect(badLinks(clean)).toEqual([]);
    expect(clean).toEqual({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "old link" }] }] });
    // Unknown attributes (a `title` from an older editor) are dropped too.
    const titled: JSONContent = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "https://a.example/", title: null, target: "_blank" } }] }] }],
    };
    const mark = (sanitizeDoc(titled).content?.[0].content?.[0].marks ?? [])[0];
    expect(Object.keys(mark?.attrs ?? {})).not.toContain("title");
  });
});
