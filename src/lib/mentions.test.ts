import { describe, expect, it } from "vitest";
import { insertMention, parseMentions, renderMentionParts } from "./mentions";

describe("parseMentions", () => {
  it("parses ids and dedupes", () => {
    expect(parseMentions("hi @[Ann](user:a1) and @[Ann again](user:a1) @[Bo](user:b2)")).toEqual(["a1", "b2"]);
  });
  it("round-trips Arabic names", () => {
    expect(parseMentions("@[محمد أحمد](user:abc) مرحبا")).toEqual(["abc"]);
  });
  it("ignores malformed tokens and stray @", () => {
    expect(parseMentions("@ alone @[no id] @[x](user:) @[y](team:1) a@b.com")).toEqual([]);
  });
});

describe("renderMentionParts", () => {
  it("splits text and mentions", () => {
    expect(renderMentionParts("a @[محمد](user:u1) b")).toEqual([
      { text: "a " },
      { mention: { id: "u1", name: "محمد" } },
      { text: " b" },
    ]);
  });
  it("keeps malformed tokens as text", () => {
    expect(renderMentionParts("x @[bad](user:) y")).toEqual([{ text: "x @[bad](user:) y" }]);
  });
  it("handles empty", () => {
    expect(renderMentionParts("")).toEqual([]);
  });
});

describe("insertMention", () => {
  const m = { id: "u1", name: "Ann" };
  it("replaces the @query before the caret and adds a space", () => {
    const r = insertMention("hello @an there", 9, m);
    expect(r.body).toBe("hello @[Ann](user:u1)  there");
    expect(r.caret).toBe("hello @[Ann](user:u1) ".length);
  });
  it("inserts at start", () => {
    const r = insertMention("@", 1, m);
    expect(r.body).toBe("@[Ann](user:u1) ");
    expect(r.caret).toBe(r.body.length);
  });
  it("works with Arabic text around", () => {
    const r = insertMention("مرحبا @مح", 9, { id: "u2", name: "محمد" });
    expect(r.body).toBe("مرحبا @[محمد](user:u2) ");
  });
  it("appends when no @ trigger precedes the caret", () => {
    const r = insertMention("abc", 3, m);
    expect(r.body).toBe("abc@[Ann](user:u1) ");
  });
  it("strips brackets from names so tokens stay valid", () => {
    const r = insertMention("@", 1, { id: "u3", name: "A [x] (y)" });
    expect(parseMentions(r.body)).toEqual(["u3"]);
  });
});

import { insertMentionPlain, serializeMentions, mergeByTime } from "./mentions";

describe("insertMentionPlain + serializeMentions (side-map approach)", () => {
  const ann = { id: "u1", name: "Ann Lee" };
  it("inserts @name and a trailing space at the caret", () => {
    const r = insertMentionPlain("hi @an", 6, ann);
    expect(r.body).toBe("hi @Ann Lee ");
    expect(r.caret).toBe(r.body.length);
  });
  it("serializes picked mentions into tokens", () => {
    expect(serializeMentions("hi @Ann Lee, ok", [ann])).toBe("hi @[Ann Lee](user:u1), ok");
  });
  it("leaves unpicked or edited names alone", () => {
    expect(serializeMentions("hi @Ann", [ann])).toBe("hi @Ann");
    expect(serializeMentions("mail a@Ann Lee", [ann])).toBe("mail a@Ann Lee");
  });
  it("handles Arabic and prefers the longest name", () => {
    const a = { id: "a", name: "محمد" };
    const b = { id: "b", name: "محمد أحمد" };
    expect(serializeMentions("@محمد أحمد و @محمد", [a, b])).toBe("@[محمد أحمد](user:b) و @[محمد](user:a)");
  });
  it("does not match a name that is only a prefix of a longer word", () => {
    expect(serializeMentions("@Ann Leeson", [ann])).toBe("@Ann Leeson");
  });
});

describe("mergeByTime", () => {
  it("interleaves notes into messages by createdAt, keeping undated messages in place", () => {
    const msgs = [
      { id: "m1", createdAt: "2026-01-01T10:00:00Z" },
      { id: "m2" },
      { id: "m3", createdAt: "2026-01-01T12:00:00Z" },
    ];
    const notes = [
      { id: "n2", createdAt: "2026-01-01T13:00:00Z" },
      { id: "n1", createdAt: "2026-01-01T11:00:00Z" },
    ];
    expect(mergeByTime(msgs, notes).map((x) => x.id)).toEqual(["m1", "m2", "n1", "m3", "n2"]);
  });
});
