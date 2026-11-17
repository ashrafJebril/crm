import { inviteEmail } from "./invite";
import { escapeHtml, layout } from "./layout";

describe("email templates (SP-26)", () => {
  it("layout sets lang and dir on <html> and uses logical CSS only", () => {
    const ar = layout({ lang: "ar", title: "t", bodyHtml: "<p>x</p>" });
    expect(ar).toMatch(/<html lang="ar" dir="rtl">/);
    const en = layout({ lang: "en", title: "t", bodyHtml: "<p>x</p>", brand: { name: "Acme", color: "#112233" } });
    expect(en).toMatch(/<html lang="en" dir="ltr">/);
    expect(en).toContain("Acme");
    expect(en).toContain("#112233");
    for (const html of [ar, en]) {
      expect(html).not.toMatch(/(padding|margin)-(left|right)|text-align:\s*(left|right)|float:/);
    }
  });

  it("layout ignores an unsafe brand colour and escapes the brand name", () => {
    const html = layout({ lang: "en", title: "t", bodyHtml: "", brand: { name: "<b>x</b>", color: "red;background:url(x)" } });
    expect(html).not.toContain("url(x)");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  it("escapeHtml escapes markup and quotes", () => {
    expect(escapeHtml(`<a href="x">'&`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
  });

  it("invite email is one language, escapes names and carries the link", () => {
    const base = {
      to: "new@x.test",
      workspaceName: "Acme <script>",
      inviterName: "Sara",
      roleName: "Agent",
      link: "https://app.test/invite?token=abc&x=1",
      expiresAt: new Date("2026-11-24T00:00:00Z"),
    };
    const ar = inviteEmail({ ...base, lang: "ar" });
    expect(ar.subject).toContain("دعوة");
    expect(ar.html).toMatch(/dir="rtl"/);
    expect(ar.html).not.toContain("<script>");
    expect(ar.html).toContain("Acme &lt;script&gt;");
    expect(ar.html).toContain("https://app.test/invite?token=abc&amp;x=1");
    expect(ar.text).toContain("https://app.test/invite?token=abc&x=1");
    expect(ar.text).toMatch(/2026/); // Latin digits
    expect(ar.html).not.toMatch(/You're invited/);
    expect(ar.kind).toBe("invite");

    const en = inviteEmail({ ...base, lang: "en", inviterName: null, roleName: null });
    expect(en.subject).toBe("You're invited to join Acme <script>");
    expect(en.html).toMatch(/dir="ltr"/);
    expect(en.text).toContain("You have been invited");
    expect(en.html).not.toMatch(/دعوة/);
  });
});
