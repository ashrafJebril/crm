import { Logger } from "@nestjs/common";
import { MetaGraphClient, metaGraphBase } from "../whatsapp/meta-graph.client";
import { fakeGraph, graphError, isolateEnv, type GraphHandler } from "../whatsapp/test-graph";
import { mergeHealth } from "./health-model";
import { readMetaHealth } from "./meta-health.reader";

const TOKEN = "EAAG-SECRET-TOKEN-123456789";
const NOW = new Date("2026-11-09T10:00:00.000Z");
const field = (name: string) => new RegExp(`^GET https://graph\\.facebook\\.com/v21\\.0/(pn1|waba1)\\?fields=${name}$`);

function phoneHandlers(over: Partial<Record<string, GraphHandler[1]>> = {}): GraphHandler[] {
  const values: Record<string, GraphHandler[1]> = {
    quality_rating: { body: { quality_rating: "YELLOW", id: "pn1" } },
    whatsapp_business_manager_messaging_limit: { body: { whatsapp_business_manager_messaging_limit: "TIER_10K", id: "pn1" } },
    messaging_limit_tier: { body: { messaging_limit_tier: "TIER_2K", id: "pn1" } },
    name_status: { body: { name_status: "APPROVED", id: "pn1" } },
    code_verification_status: { body: { code_verification_status: "VERIFIED", id: "pn1" } },
    health_status: { body: { health_status: { can_send_message: "LIMITED", entities: [] }, id: "pn1" } },
    status: { body: { status: "CONNECTED", id: "pn1" } },
    business_verification_status: { body: { business_verification_status: "VERIFIED", id: "waba1" } },
    account_review_status: { body: { account_review_status: "APPROVED", id: "waba1" } },
    ...over,
  } as Record<string, GraphHandler[1]>;
  return [
    [/message_templates/, { body: { data: [], paging: {} } }],
    ...Object.entries(values).map(([k, v]) => [field(k), v] as GraphHandler),
  ];
}

describe("meta reader reads one field per call and falls back for the messaging limit", () => {
  let restore: () => void;
  let logs: jest.SpyInstance[];
  beforeEach(() => {
    restore = isolateEnv();
    logs = (["log", "warn", "error", "debug", "verbose"] as const).map((m) => jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined));
  });
  afterEach(() => {
    const logged = logs.flatMap((s) => s.mock.calls.map((c) => JSON.stringify(c)));
    for (const line of logged) expect(line).not.toContain(TOKEN);
    logs.forEach((s) => s.mockRestore());
    restore();
  });

  it("one Graph field per request, token in the Authorization header only", async () => {
    const g = fakeGraph(phoneHandlers());
    const read = await readMetaHealth(new MetaGraphClient(g.fetch), { accessToken: TOKEN, externalId: "pn1" }, "waba1");
    const nonTemplate = g.calls.filter((c) => !c.url.includes("message_templates"));
    expect(nonTemplate).toHaveLength(8); // 6 phone fields (new limit field answered) + 2 WABA
    for (const c of nonTemplate) {
      const fields = new URL(c.url).searchParams.get("fields")!;
      expect(fields.split(",")).toHaveLength(1);
      expect(c.url).not.toContain(TOKEN);
      expect(c.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    }
    const h = mergeHealth(null, read, { now: NOW, trigger: "manual" });
    expect(h.tier.value).toBe("TIER_10K");
    expect(h.messaging.value).toBe("LIMITED");
    expect(h.quality.value).toBe("YELLOW");
    expect(g.called("messaging_limit_tier")).toHaveLength(0);
  });

  it("whatsapp_business_manager_messaging_limit #100 → messaging_limit_tier → TIER_2K", async () => {
    const g = fakeGraph(phoneHandlers({ whatsapp_business_manager_messaging_limit: graphError(100, "Unknown field") }));
    const read = await readMetaHealth(new MetaGraphClient(g.fetch), { accessToken: TOKEN, externalId: "pn1" }, "waba1");
    expect(mergeHealth(null, read, { now: NOW, trigger: "manual" }).tier).toEqual({
      value: "TIER_2K",
      checkedAt: NOW.toISOString(),
      error: null,
    });
    expect(g.called("whatsapp_business_manager_messaging_limit")).toHaveLength(1);
    expect(g.called("fields=messaging_limit_tier")).toHaveLength(1);
  });

  it("both limit fields failing → unknown", async () => {
    const g = fakeGraph(
      phoneHandlers({
        whatsapp_business_manager_messaging_limit: graphError(100),
        messaging_limit_tier: { status: 500, body: { error: { message: "oops", code: 1 } } },
      }),
    );
    const read = await readMetaHealth(new MetaGraphClient(g.fetch), { accessToken: TOKEN, externalId: "pn1" }, "waba1");
    const h = mergeHealth(null, read, { now: NOW, trigger: "manual" });
    expect(h.tier).toEqual({ value: "unknown", checkedAt: NOW.toISOString(), error: "check_failed" });
    // The other fields stand alone.
    expect(h.quality.value).toBe("YELLOW");
  });

  it("Graph 190 / 200 / 10 → permission_denied; other codes → check_failed", async () => {
    const g = fakeGraph(
      phoneHandlers({
        quality_rating: graphError(190, `Error validating access token ${TOKEN}`, 401),
        name_status: graphError(200, "Permissions error", 403),
        account_review_status: graphError(10, "Application does not have permission"),
        status: graphError(2, "Service temporarily unavailable", 503),
      }),
    );
    const read = await readMetaHealth(new MetaGraphClient(g.fetch), { accessToken: TOKEN, externalId: "pn1" }, "waba1");
    const h = mergeHealth(null, read, { now: NOW, trigger: "manual" });
    expect(h.quality.error).toBe("permission_denied");
    expect(h.nameStatus.error).toBe("permission_denied");
    expect(h.accountReview.error).toBe("permission_denied");
    expect(h.phoneStatus.error).toBe("check_failed");
    // Graph's text is never stored.
    expect(JSON.stringify(h)).not.toContain("validating");
    expect(JSON.stringify(h)).not.toContain(TOKEN);
  });

  it("no token → missing_credentials with zero Graph calls", async () => {
    const g = fakeGraph([]);
    const read = await readMetaHealth(new MetaGraphClient(g.fetch), { externalId: "pn1" }, "waba1");
    expect(g.fetch).not.toHaveBeenCalled();
    const h = mergeHealth(null, read, { now: NOW, trigger: "manual" });
    for (const f of ["quality", "tier", "nameStatus", "verified", "codeVerification", "messaging", "phoneStatus", "accountReview"] as const) {
      expect({ f, s: h[f] }).toEqual({ f, s: { value: "unknown", checkedAt: NOW.toISOString(), error: "missing_credentials" } });
    }
    expect(h.templates.error).toBe("missing_credentials");
  });

  it("no WABA id → WABA fields and templates missing_credentials, phone fields still read", async () => {
    const g = fakeGraph(phoneHandlers());
    const read = await readMetaHealth(new MetaGraphClient(g.fetch), { accessToken: TOKEN, externalId: "pn1" }, null);
    const h = mergeHealth(null, read, { now: NOW, trigger: "manual" });
    expect(h.verified.error).toBe("missing_credentials");
    expect(h.accountReview.error).toBe("missing_credentials");
    expect(h.templates.error).toBe("missing_credentials");
    expect(h.quality.value).toBe("YELLOW");
    expect(g.calls.some((c) => c.url.includes("waba1"))).toBe(false);
  });

  it("the token never appears in a thrown error", async () => {
    const g = fakeGraph([[/quality_rating/, graphError(190, `bad token ${TOKEN}`, 401)]]);
    const err = (await new MetaGraphClient(g.fetch).getField("pn1", "quality_rating", TOKEN).catch((e: unknown) => e)) as Error;
    expect(String(err.message)).not.toContain(TOKEN);
    expect(JSON.stringify(err)).not.toContain(TOKEN);
    expect(String(err.stack)).not.toContain(TOKEN);
  });

  it("templates: at most 5 pages of 100, truncation flagged; a failing page makes templates unknown", async () => {
    let page = 0;
    const g = fakeGraph([
      [
        /message_templates/,
        () => {
          page++;
          return {
            body: {
              data: [{ id: `t${page}`, name: `n${page}`, language: "en", status: page === 2 ? "PAUSED" : "APPROVED", quality_score: { score: "RED" } }],
              paging: { cursors: { after: `c${page}` }, next: "https://graph.facebook.com/next" },
            },
          };
        },
      ],
      ...phoneHandlers().slice(1),
    ]);
    const read = await readMetaHealth(new MetaGraphClient(g.fetch), { accessToken: TOKEN, externalId: "pn1" }, "waba1");
    const calls = g.called("message_templates");
    expect(calls).toHaveLength(5);
    expect(new URL(calls[0].url).searchParams.get("limit")).toBe("100");
    expect(new URL(calls[0].url).searchParams.get("fields")).toBe("id,name,language,status,quality_score,category,rejected_reason");
    expect(new URL(calls[1].url).searchParams.get("after")).toBe("c1");
    const t = mergeHealth(null, read, { now: NOW, trigger: "manual" }).templates.value;
    expect(t).toMatchObject({ total: 5, paused: 1, approved: 4, lowQuality: 5, truncated: true });

    const bad = fakeGraph([[/message_templates/, graphError(1, "boom", 500)], ...phoneHandlers().slice(1)]);
    const r2 = await readMetaHealth(new MetaGraphClient(bad.fetch), { accessToken: TOKEN, externalId: "pn1" }, "waba1");
    expect(r2.templates).toEqual({ error: "check_failed" });
  });
});

describe("meta graph base url accepts only graph.facebook.com or loopback", () => {
  it.each([
    [undefined, "https://graph.facebook.com"],
    ["", "https://graph.facebook.com"],
    ["https://graph.facebook.com", "https://graph.facebook.com"],
    ["https://graph.facebook.com/", "https://graph.facebook.com"],
    ["http://127.0.0.1:4599", "http://127.0.0.1:4599"],
    ["http://127.0.0.1:99999", "https://graph.facebook.com"],
    ["http://localhost:4599", "https://graph.facebook.com"],
    ["https://evil.example.com", "https://graph.facebook.com"],
    ["http://graph.facebook.com", "https://graph.facebook.com"],
    ["https://graph.facebook.com.evil.com", "https://graph.facebook.com"],
    ["http://127.0.0.1:4599@evil.com", "https://graph.facebook.com"],
    ["http://127.0.0.2:4599", "https://graph.facebook.com"],
  ])("%s → %s", (env, base) => {
    expect(metaGraphBase({ META_GRAPH_BASE_URL: env })).toBe(base);
  });

  it("the client sends to the honoured base, and never to a rejected one", async () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const restore = isolateEnv();
    try {
      process.env.META_GRAPH_BASE_URL = "http://127.0.0.1:4599";
      const g = fakeGraph([[/127\.0\.0\.1:4599\/v21\.0\/pn1\?fields=status/, { body: { status: "CONNECTED" } }]]);
      expect(await new MetaGraphClient(g.fetch).getField("pn1", "status", TOKEN)).toBe("CONNECTED");
      process.env.META_GRAPH_BASE_URL = "https://evil.example.com";
      const g2 = fakeGraph([[/^GET https:\/\/graph\.facebook\.com\/v21\.0\/pn1\?fields=status$/, { body: { status: "CONNECTED" } }]]);
      expect(await new MetaGraphClient(g2.fetch).getField("pn1", "status", TOKEN)).toBe("CONNECTED");
      for (const c of warn.mock.calls) expect(JSON.stringify(c)).not.toContain("evil");
    } finally {
      restore();
      warn.mockRestore();
    }
  });

  it("getField refuses a field name that could add edges or parameters", async () => {
    const g = fakeGraph([]);
    await expect(new MetaGraphClient(g.fetch).getField("pn1", "status&access_token=x", TOKEN)).rejects.toThrow("Invalid Graph field");
    expect(g.fetch).not.toHaveBeenCalled();
  });
});
