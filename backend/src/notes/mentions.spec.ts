import { excerptOf, parseMentions, renderMentions } from "./mentions";

describe("excerptOf", () => {
  it("returns short text unchanged", () => {
    expect(excerptOf("hello")).toBe("hello");
  });
  it("never cuts an emoji or combined sequence at the limit", () => {
    const family = "👨‍👩‍👧"; // one grapheme, several code points
    const text = "a".repeat(119) + family + "tail";
    expect(excerptOf(text)).toBe("a".repeat(119) + family);
    const astral = "b".repeat(119) + "😀" + "x";
    expect(excerptOf(astral)).toBe("b".repeat(119) + "😀");
  });
});

describe("mentions", () => {
  it("parseMentions handles Arabic names and dedupes", () => {
    const body = "مرحبا @[محمد أحمد](user:abc) و @[Sara](user:d-1_x) ثم @[محمد](user:abc)";
    expect(parseMentions(body)).toEqual(["abc", "d-1_x"]);
    expect(renderMentions("@[محمد أحمد](user:abc) hi")).toBe("@محمد أحمد hi");
  });

  it("malformed tokens are plain text", () => {
    expect(parseMentions("email a@b.com @ @[x](user:) @[x(user:a) @[x](usr:a) @[x]](user:a)")).toEqual([]);
  });
});
