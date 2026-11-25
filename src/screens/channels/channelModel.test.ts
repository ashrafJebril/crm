import { describe, expect, it } from "vitest";
import type { ChannelDto } from "@/lib/types";
import {
  apiOriginFrom,
  publicOrigin,
  buildSnippet,
  canMakeDefault,
  canReconnect,
  channelLabels,
  chatPageUrl,
  disconnectConfirmBody,
  groupChannels,
  landlineView,
  limitState,
  limitView,
  needsSync,
  statusBadge,
  validateOrigin,
  validateWebchatForm,
} from "./channelModel";

const ARABIC = /[؀-ۿ]/;

const ch = (over: Partial<ChannelDto>): ChannelDto => ({
  id: "c1",
  kind: "whatsapp",
  provider: "zernio",
  externalId: "acc",
  displayName: "Shop",
  phoneNumber: null,
  status: "active",
  statusReason: null,
  isDefault: false,
  config: null,
  lastInboundAt: null,
  createdAt: "2026-11-01T00:00:00Z",
  ...over,
});

describe("statusBadge", () => {
  it.each([
    ["active", "ok"],
    ["needs_attention", "warn"],
    ["pending", "info"],
    ["error", "bad"],
    ["disconnected", ""],
  ])("%s → tone %s with EN and AR", (status, tone) => {
    const b = statusBadge(status);
    expect(b.tone).toBe(tone);
    expect(b.en.length).toBeGreaterThan(2);
    expect(ARABIC.test(b.ar)).toBe(true);
  });

  it("falls back for an unknown status", () => {
    expect(statusBadge("weird").tone).toBe("warn");
  });
});

describe("groupChannels", () => {
  it("groups live channels by kind in a stable order and splits out disconnected ones", () => {
    const list = [
      ch({ id: "t", kind: "telegram", provider: "telegram" }),
      ch({ id: "w2", kind: "whatsapp", createdAt: "2026-11-03T00:00:00Z" }),
      ch({ id: "w1", kind: "whatsapp", isDefault: true, createdAt: "2026-11-05T00:00:00Z" }),
      ch({ id: "x", kind: "snapchat" }),
      ch({ id: "d", kind: "whatsapp", status: "disconnected" }),
      ch({ id: "wc", kind: "webchat", provider: "native" }),
    ];
    const g = groupChannels(list);
    expect(g.groups.map((x) => x.kind)).toEqual(["whatsapp", "telegram", "webchat", "snapchat"]);
    expect(g.groups[0]!.channels.map((c) => c.id)).toEqual(["w1", "w2"]); // default first
    expect(g.disconnected.map((c) => c.id)).toEqual(["d"]);
    expect(g.total).toBe(6);
  });

  it("is empty for no channels", () => {
    expect(groupChannels([])).toEqual({ groups: [], disconnected: [], total: 0 });
  });
});

describe("apiOriginFrom", () => {
  it("strips /api and a trailing slash", () => {
    expect(apiOriginFrom("https://api.kewy.io/api", "https://app.kewy.io")).toBe("https://api.kewy.io");
    expect(apiOriginFrom("http://localhost:4100/api/", "http://localhost:5174")).toBe("http://localhost:4100");
  });
  it("resolves a relative base against the page origin", () => {
    expect(apiOriginFrom("/api", "https://app.kewy.io")).toBe("https://app.kewy.io");
  });
});

describe("publicOrigin (m1)", () => {
  it("prefers the backend's publicBaseUrl", () => {
    expect(publicOrigin("https://api.kewy.ai/", "/api", "https://app.kewy.ai")).toBe("https://api.kewy.ai");
    expect(publicOrigin("https://api.kewy.ai", "http://localhost:4100/api", "http://localhost:5174")).toBe("https://api.kewy.ai");
  });
  it("falls back to the API base when it is missing or malformed", () => {
    expect(publicOrigin(undefined, "http://localhost:4100/api", "http://localhost:5174")).toBe("http://localhost:4100");
    expect(publicOrigin("javascript:alert(1)", "/api", "https://app.kewy.ai")).toBe("https://app.kewy.ai");
    expect(publicOrigin("not a url", "/api", "https://app.kewy.ai")).toBe("https://app.kewy.ai");
  });
});

describe("buildSnippet", () => {
  it("is the exact loader tag", () => {
    expect(buildSnippet("https://api.kewy.io", "ckabc123")).toBe(
      '<script src="https://api.kewy.io/api/widget.js" data-channel="ckabc123" async></script>',
    );
  });
  it("adds data-lang only for en/ar", () => {
    expect(buildSnippet("https://api.kewy.io", "ck1", "ar")).toBe(
      '<script src="https://api.kewy.io/api/widget.js" data-channel="ck1" data-lang="ar" async></script>',
    );
    expect(buildSnippet("https://api.kewy.io", "ck1", null)).not.toContain("data-lang");
  });
  it("escapes attribute values", () => {
    const s = buildSnippet('https://a"b<c>', `x"><script>alert('1')&`);
    expect(s).toBe(
      '<script src="https://a&quot;b&lt;c&gt;/api/widget.js" data-channel="x&quot;&gt;&lt;script&gt;alert(&#39;1&#39;)&amp;" async></script>',
    );
  });
});

describe("chatPageUrl", () => {
  it("is the hosted page on the API origin", () => {
    expect(chatPageUrl("https://api.kewy.io", "ck1")).toBe("https://api.kewy.io/api/chat/ck1");
    expect(chatPageUrl("https://api.kewy.io", "ck1", "ar")).toBe("https://api.kewy.io/api/chat/ck1?lang=ar");
    expect(chatPageUrl("https://api.kewy.io", "a/b")).toBe("https://api.kewy.io/api/chat/a%2Fb");
  });
});

describe("validateOrigin (mirrors backend origin-match.ts)", () => {
  const dev = { production: false };
  const prod = { production: true };
  it.each([
    ["https://shop.example", "https://shop.example"],
    ["HTTPS://Shop.Example:443", "https://shop.example"],
    ["https://shop.example:8443", "https://shop.example:8443"],
    ["https://*.shop.com", "https://*.shop.com"],
    [" https://a.b.c ", "https://a.b.c"],
  ])("accepts %s", (raw, norm) => {
    expect(validateOrigin(raw, prod)).toEqual({ ok: true, value: norm });
  });

  it.each([
    "shop.example",
    "https://shop.example/",
    "https://shop.example/path",
    "https://shop.example?x=1",
    "https://user@shop.example",
    "*",
    "https://*",
    "https://*.com",
    "https://shop.example:*",
    "https://shop.example:70000",
    "https://-bad.example",
    "ftp://shop.example",
    "http://shop.example",
    "http://*.localhost",
    "",
  ])("rejects %s", (raw) => {
    expect(validateOrigin(raw, dev).ok).toBe(false);
  });

  it("allows http localhost only outside production", () => {
    expect(validateOrigin("http://localhost:5173", dev)).toEqual({ ok: true, value: "http://localhost:5173" });
    expect(validateOrigin("http://127.0.0.1:*", dev)).toEqual({ ok: true, value: "http://127.0.0.1:*" });
    expect(validateOrigin("http://localhost:80", dev)).toEqual({ ok: true, value: "http://localhost" });
    expect(validateOrigin("http://localhost:5173", prod).ok).toBe(false);
  });
});

describe("validateWebchatForm (mirrors validateWebchatConfig)", () => {
  const base = {
    allowedOrigins: ["https://shop.example"],
    greeting: " Hi ",
    greetingAr: "",
    color: "#22AA88",
    position: "end" as const,
    askName: true,
    lang: null,
  };
  it("returns the normalized config", () => {
    const r = validateWebchatForm(base, { production: true });
    expect(r.errors).toEqual({});
    expect(r.config).toEqual({
      allowedOrigins: ["https://shop.example"],
      greeting: "Hi",
      greetingAr: null,
      color: "#22AA88",
      position: "end",
      askName: true,
      lang: null,
    });
  });
  it("dedupes origins after normalizing", () => {
    const r = validateWebchatForm({ ...base, allowedOrigins: ["https://A.com", "https://a.com:443"] }, { production: true });
    expect(r.config.allowedOrigins).toEqual(["https://a.com"]);
  });
  it("flags each bad field", () => {
    const r = validateWebchatForm(
      {
        allowedOrigins: Array.from({ length: 21 }, (_, i) => `https://s${i}.example`),
        greeting: "x".repeat(281),
        greetingAr: "ب".repeat(281),
        color: "red",
        position: "left" as never,
        askName: false,
        lang: "fr" as never,
      },
      { production: true },
    );
    expect(Object.keys(r.errors).sort()).toEqual(["allowedOrigins", "color", "greeting", "greetingAr", "lang", "position"]);
  });
  it("points at the bad origin", () => {
    const r = validateWebchatForm({ ...base, allowedOrigins: ["https://ok.com", "nope"] }, { production: true });
    expect(r.errors.allowedOrigins).toEqual({ index: 1 });
  });
  it("allows an empty origin list (link-only channel)", () => {
    expect(validateWebchatForm({ ...base, allowedOrigins: [] }, { production: true }).errors).toEqual({});
  });
});

describe("limit display", () => {
  it("is ok below the limit and at_limit at or over it", () => {
    expect(limitState({ whatsapp: { used: 0, limit: 1, plan: "free" } })).toBe("ok");
    expect(limitState({ whatsapp: { used: 1, limit: 1, plan: "free" } })).toBe("at_limit");
    expect(limitState({ whatsapp: { used: 4, limit: 3, plan: "growth" } })).toBe("at_limit");
    expect(limitState(null)).toBe("ok");
  });
  it("describes usage in both languages", () => {
    const v = limitView({ whatsapp: { used: 2, limit: 3, plan: "growth" } })!;
    expect(v.state).toBe("ok");
    expect(v.en).toBe("2 of 3 WhatsApp numbers used (Growth plan)");
    expect(ARABIC.test(v.ar)).toBe(true);
    expect(v.ar).toContain("2");
    expect(v.percent).toBeCloseTo(66.67, 1);
    expect(limitView({ whatsapp: { used: 5, limit: 3, plan: "x" } })!.percent).toBe(100);
    expect(limitView(null)).toBeNull();
  });
});

describe("landlineView", () => {
  const now = Date.parse("2026-11-09T10:00:00Z");
  it("is null without a verification stage", () => {
    expect(landlineView(ch({ status: "active" }), now)).toBeNull();
  });
  it("needs_number asks for the number", () => {
    const v = landlineView(ch({ status: "pending", provider: "meta", config: { verification: { stage: "needs_number" } } }), now)!;
    expect(v.step).toBe("number");
  });
  it("awaiting_code counts the cooldown down", () => {
    const c = ch({
      status: "pending",
      provider: "meta",
      phoneNumber: "+966111",
      config: { verification: { stage: "awaiting_code", resendAt: "2026-11-09T10:00:42.300Z" } },
    });
    const v = landlineView(c, now)!;
    expect(v.step).toBe("code");
    expect(v.secondsLeft).toBe(43);
    expect(v.canRequestCode).toBe(false);
    expect(v.phone).toBe("+966111");
    const later = landlineView(c, now + 60_000)!;
    expect(later.secondsLeft).toBe(0);
    expect(later.canRequestCode).toBe(true);
  });
  it("an override resendAt (from a cooldown error) wins when later", () => {
    const c = ch({ status: "pending", provider: "meta", config: { verification: { stage: "awaiting_code" } } });
    expect(landlineView(c, now, "2026-11-09T10:00:10Z")!.secondsLeft).toBe(10);
  });
  it("needs_registration offers the register retry", () => {
    const v = landlineView(ch({ status: "pending", provider: "meta", config: { verification: { stage: "needs_registration" } } }), now)!;
    expect(v.step).toBe("register");
  });
  it("ignores garbage stages", () => {
    expect(landlineView(ch({ config: { verification: { stage: "x" as never } } }), now)).toBeNull();
  });
});

describe("action availability", () => {
  it("Sync only for zernio_account_missing (M-d)", () => {
    expect(needsSync(ch({ status: "disconnected", statusReason: "zernio_account_missing" }))).toBe(true);
    expect(needsSync(ch({ status: "disconnected", statusReason: "disconnected_by_user" }))).toBe(false);
  });
  it("make default only for an active, non-default channel", () => {
    expect(canMakeDefault(ch({ status: "active" }))).toBe(true);
    expect(canMakeDefault(ch({ status: "active", isDefault: true }))).toBe(false);
    expect(canMakeDefault(ch({ status: "needs_attention" }))).toBe(false);
  });
  it("reconnect where the backend has a hook or Zernio re-auth applies", () => {
    expect(canReconnect(ch({ provider: "telegram", status: "error" }))).toBe(true);
    expect(canReconnect(ch({ provider: "meta", status: "disconnected" }))).toBe(true);
    expect(canReconnect(ch({ provider: "zernio", status: "needs_attention" }))).toBe(true);
    // m5: web chat has a native reconnect hook now.
    expect(canReconnect(ch({ provider: "native", kind: "webchat", status: "disconnected" }))).toBe(true);
    expect(canReconnect(ch({ provider: "native", kind: "webchat", status: "active" }))).toBe(false);
    // I1: a hub-disconnected Zernio channel offers Reconnect.
    expect(canReconnect(ch({ provider: "zernio", status: "disconnected", statusReason: "disconnected_by_user" }))).toBe(true);
    expect(canReconnect(ch({ provider: "kapso", status: "disconnected" }))).toBe(false);
    expect(canReconnect(ch({ provider: "telegram", status: "active" }))).toBe(false);
    // A landline row is driven by its card, not by reconnect.
    expect(canReconnect(ch({ provider: "meta", status: "pending", config: { verification: { stage: "needs_number" } } }))).toBe(false);
  });
});

describe("channelLabels (SP-19 I1)", () => {
  it("a unique name is shown as is, falling back to the phone, then the kind", () => {
    const m = channelLabels([
      ch({ id: "a", displayName: "Sales", phoneNumber: "+971500000001" }),
      ch({ id: "b", displayName: "", phoneNumber: "+971500000002" }),
      ch({ id: "c", kind: "telegram", displayName: "", phoneNumber: null }),
    ]);
    expect(m.get("a")).toBe("Sales");
    expect(m.get("b")).toBe("+971500000002");
    expect(m.get("c")).toBe("telegram");
  });
  it("two channels sharing a name show name · phone, else name · #last 4 of the external id", () => {
    const m = channelLabels([
      ch({ id: "a", displayName: "Shop", phoneNumber: "+971500000001", externalId: "acc-1111" }),
      ch({ id: "b", displayName: "Shop", phoneNumber: null, externalId: "acc-98765" }),
      ch({ id: "c", displayName: " shop ", phoneNumber: null, externalId: null }),
      ch({ id: "d", displayName: "Support", phoneNumber: "+971500000004" }),
    ]);
    expect(m.get("a")).toBe("Shop · +971500000001");
    expect(m.get("b")).toBe("Shop · #8765");
    expect(m.get("c")).toBe("shop");
    expect(m.get("d")).toBe("Support");
  });
});

describe("disconnectConfirmBody (SP-19 m2)", () => {
  const tx = (en: string, ar: string) => `${en}|${ar}`;
  it("Meta numbers: replies blocked, incoming may still arrive (EN/AR)", () => {
    // Meta's disconnect is still only ours, so the old wording still holds.
    const [en, ar] = disconnectConfirmBody(ch({ provider: "meta", kind: "whatsapp" }), tx).split("|");
    expect(en).toMatch(/Replies from this number will be blocked; incoming messages may still arrive/);
    expect(en).not.toMatch(/stop arriving/);
    expect(ar).toMatch(ARABIC);
  });
  it("Zernio: says the account is disconnected at Zernio too (EN/AR)", () => {
    // A Zernio disconnect is now a real removal upstream, so the dialog must
    // not keep implying the channel merely goes quiet on our side.
    const [en, ar] = disconnectConfirmBody(ch({ provider: "zernio", kind: "instagram" }), tx).split("|");
    expect(en).toMatch(/disconnects the account from Zernio as well/);
    expect(en).toMatch(/authorise the account again/);
    expect(ar).toMatch(ARABIC);
  });
  it("Zernio WhatsApp: warns the number itself may not come back (EN/AR)", () => {
    // Zernio deletes the account after a one-hour grace window and does not
    // document whether a bought number is released. Someone clicking this
    // deserves to know that before, not after.
    const [en, ar] = disconnectConfirmBody(ch({ provider: "zernio", kind: "whatsapp" }), tx).split("|");
    expect(en).toMatch(/disconnects the number from Zernio as well/);
    expect(en).toMatch(/not guaranteed/);
    expect(ar).toMatch(ARABIC);
  });
  it("Telegram and web chat keep the stop-arriving text", () => {
    for (const c of [ch({ provider: "telegram", kind: "telegram" }), ch({ provider: "native", kind: "webchat" })]) {
      expect(disconnectConfirmBody(c, tx)).toMatch(/new messages stop arriving/);
    }
  });
});
