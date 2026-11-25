import { describe, expect, it } from "vitest";
import { getSchema, type JSONContent } from "@tiptap/core";
import type { Node as PMNode, Schema } from "@tiptap/pm/model";
import { badLinks, knowledgeExtensions, safeLink, sanitizeDoc, upgradePastedLinks } from "./contentDoc";

/**
 * The backend validator, loaded at run time from its own file (a dynamic
 * import with a computed path, so the app's type-check never compiles backend
 * code; vitest transpiles it and resolves @nestjs from backend/node_modules).
 */
const BACKEND_CONTENT = "../../../backend/src/knowledge-sources/knowledge-content.ts";
type TiptapToText = (doc: unknown) => string;
async function backendTiptapToText(): Promise<TiptapToText> {
  const mod = (await import(/* @vite-ignore */ BACKEND_CONTENT)) as { tiptapToText: TiptapToText };
  return mod.tiptapToText;
}

/** Build a document through the editor's real schema (what `editor.getJSON()` returns is `doc.toJSON()`). */
function editorDoc(schema: Schema, build: (s: Schema) => PMNode): JSONContent {
  const doc = build(schema);
  doc.check(); // valid for this schema
  return doc.toJSON() as JSONContent;
}

describe("content editor JSON against the backend validator", () => {
  const schema = getSchema(knowledgeExtensions());

  // 20s, not the 5s default: this one dynamically imports the backend's
  // validator, which takes ~3s on an idle machine and tips over the default
  // whenever the suite runs alongside anything else (it has failed twice
  // that way). The budget is module loading, not what is asserted.
  it("the editor's link, headings, lists and marks pass the backend's tiptapToText", async () => {
    const tiptapToText = await backendTiptapToText();
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
    const text = tiptapToText(json);
    expect(text).toContain("# About us");
    expect(text).toContain("our site (https://example.com/book)");
    expect(text).toContain("- Haircut");
    expect(text).toContain("1. Book");
    // The pre-save sanitizer leaves a valid document unchanged and valid.
    expect(sanitizeDoc(json)).toEqual(json);
    expect(() => tiptapToText(sanitizeDoc(json))).not.toThrow();
  }, 20_000);

  it("the schema has only what the backend accepts", () => {
    expect(Object.keys(schema.nodes).sort()).toEqual(["bulletList", "doc", "hardBreak", "heading", "listItem", "orderedList", "paragraph", "text"].sort());
    expect(Object.keys(schema.marks).sort()).toEqual(["bold", "italic", "link"]);
    expect(Object.keys(schema.marks.link.spec.attrs ?? {}).sort()).toEqual(["class", "href", "rel", "target"]);
  });

  it("http links never reach the backend: refused, upgraded on paste, or dropped before saving", async () => {
    const tiptapToText = await backendTiptapToText();
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
    expect(() => tiptapToText(withHttp)).toThrow();
    const clean = sanitizeDoc(withHttp);
    expect(badLinks(clean)).toEqual([]);
    expect(tiptapToText(clean)).toBe("old link");
    // Unknown attributes (a `title` from an older editor) are dropped too.
    const titled: JSONContent = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "https://a.example/", title: null, target: "_blank" } }] }] }],
    };
    expect(() => tiptapToText(titled)).toThrow();
    expect(() => tiptapToText(sanitizeDoc(titled))).not.toThrow();
  });
});
