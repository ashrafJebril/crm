import { escapeHtml, renderChatPage } from "./hosted-page";
import { CHAT_PAGE_JS } from "./assets/chat-page.js";
import { WIDGET_JS } from "./assets/widget.js";

const dev = { production: false };
const base = {
  channel: { id: "W1", displayName: "Shop", config: { allowedOrigins: ["https://shop.example", "https://*.shop.com"] } },
  lang: "en" as const,
  embed: true,
  nonce: "bm9uY2U=",
  apiOrigin: "https://api.example.com",
  parent: "https://shop.example",
  originOpts: dev,
};

describe("hosted page escapes display name and sets frame-ancestors", () => {
  it("escapes the display name everywhere it is rendered", () => {
    const evil = `</title><script>alert(1)</script><img src=x onerror="alert(2)">'&`;
    const { html } = renderChatPage({ ...base, channel: { ...base.channel, displayName: evil } });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain('onerror="alert(2)"');
    expect(html).toContain("&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&#39;&amp;");
    // exactly one <script>, the nonce'd client
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).toContain(`<script nonce="${base.nonce}">`);
  });

  it("escapes attribute values (parent, channel id)", () => {
    const { html } = renderChatPage({ ...base, parent: `https://x" onload="alert(1)`, channel: { ...base.channel, id: `W1"><b>` } });
    expect(html).not.toContain(`" onload="`);
    expect(html).not.toContain(`"><b>`);
    expect(html).toContain("&quot;");
  });

  it("embed mode: frame-ancestors lists the allowed origins; direct link: 'none'", () => {
    const embed = renderChatPage(base);
    expect(embed.csp).toContain("frame-ancestors https://shop.example https://*.shop.com");
    const direct = renderChatPage({ ...base, embed: false });
    expect(direct.csp).toContain("frame-ancestors 'none'");
    expect(direct.html).toContain('data-parent=""');
    const none = renderChatPage({ ...base, channel: { ...base.channel, config: {} } });
    expect(none.csp).toContain("frame-ancestors 'none'");
  });

  it("re-validates stored origins: invalid or (in production) http entries never reach the CSP", () => {
    const config = { allowedOrigins: ["https://ok.example", "http://localhost:5173", "*", "https://x.example; script-src *"] };
    const prod = renderChatPage({ ...base, channel: { ...base.channel, config }, originOpts: { production: true } });
    expect(prod.csp.endsWith("frame-ancestors https://ok.example")).toBe(true);
    expect(prod.csp).not.toContain("localhost");
    expect(prod.csp).not.toContain("script-src *");
  });

  it("the CSP is locked down: nonce'd scripts/styles, same-origin + wss connect, no base or form targets", () => {
    const { csp } = renderChatPage(base);
    expect(csp.split("; ")).toEqual([
      "default-src 'none'",
      "script-src 'self' 'nonce-bm9uY2U='",
      "style-src 'nonce-bm9uY2U='",
      "connect-src 'self' wss://api.example.com",
      "img-src 'self' data:",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors https://shop.example https://*.shop.com",
    ]);
    expect(renderChatPage({ ...base, apiOrigin: "http://localhost:3001" }).csp).toContain("connect-src 'self' ws://localhost:3001");
  });

  it("Arabic renders RTL with Arabic labels; English LTR", () => {
    const ar = renderChatPage({ ...base, lang: "ar" }).html;
    expect(ar).toContain('<html lang="ar" dir="rtl">');
    expect(ar).toContain("إرسال");
    expect(ar).toContain('data-lang="ar"');
    const en = renderChatPage(base).html;
    expect(en).toContain('<html lang="en" dir="ltr">');
    expect(en).toContain(">Send<");
  });

  it("uses no inline style attributes or inline event handlers (both would be CSP-blocked)", () => {
    const { html } = renderChatPage(base);
    expect(html).not.toMatch(/\sstyle="/);
    expect(html).not.toMatch(/\son[a-z]+="/);
  });

  it("escapeHtml covers the HTML-significant characters", () => {
    expect(escapeHtml(`<a href="x">'&\``)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#96;");
    expect(escapeHtml(null)).toBe("");
  });
});

describe("widget assets", () => {
  it("the loader stays under 4 KB", () => {
    expect(Buffer.byteLength(WIDGET_JS, "utf8")).toBeLessThan(4096);
  });

  it.each([
    ["widget.js", WIDGET_JS],
    ["chat-page.js", CHAT_PAGE_JS],
  ])("%s uses no eval-like or HTML-injecting APIs", (_name, src) => {
    for (const bad of [/\beval\s*\(/, /new\s+Function\s*\(/, /innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /setTimeout\(\s*["']/, /setInterval\(\s*["']/]) {
      expect(src).not.toMatch(bad);
    }
    // the inlined client cannot close its own <script> element
    expect(src.toLowerCase()).not.toContain("</script");
  });

  it.each([
    ["widget.js", WIDGET_JS],
    ["chat-page.js", CHAT_PAGE_JS],
  ])("%s parses as a script", (_name, src) => {
    // Syntax check only: compiling does not run it.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vm = require("node:vm") as typeof import("node:vm");
    expect(() => new vm.Script(src)).not.toThrow();
  });

  it("the loader reads data-channel/lang/position, derives the API from its src and builds the embed URL", () => {
    expect(WIDGET_JS).toContain('getAttribute("data-channel")');
    expect(WIDGET_JS).toContain('getAttribute("data-lang")');
    expect(WIDGET_JS).toContain('getAttribute("data-position")');
    expect(WIDGET_JS).toContain("document.currentScript");
    expect(WIDGET_JS).toContain('"/chat/"+encodeURIComponent(id)');
    expect(WIDGET_JS).toContain('"embed=1&parent="+encodeURIComponent(location.origin)');
  });

  it("the page client stores the visitor with an in-memory fallback, sockets on /widget and polls as fallback", () => {
    expect(CHAT_PAGE_JS).toMatch(/try\{localStorage\.setItem/);
    expect(CHAT_PAGE_JS).toContain('window.io("/widget"');
    expect(CHAT_PAGE_JS).toContain("/socket.io/socket.io.js");
    expect(CHAT_PAGE_JS).toContain("setInterval(");
    expect(CHAT_PAGE_JS).toContain("textContent");
  });
});
