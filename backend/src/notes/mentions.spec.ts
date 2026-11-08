import { parseMentions, renderMentions } from "./mentions";

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
