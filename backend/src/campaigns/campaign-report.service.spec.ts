import { EventEmitter } from "events";
import { HttpException } from "@nestjs/common";
import { makeFakePrisma } from "../channels/test-prisma";
import { CampaignReportService, EXPORT_BATCH } from "./campaign-report.service";
import { CampaignReportController } from "./campaign-report.controller";

/* eslint-disable @typescript-eslint/no-explicit-any */

const WS = "ws_a";
const T0 = new Date("2026-11-01T10:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const MIN = 60_000;
const HOUR = 60 * MIN;

function errKey(e: unknown) {
  const he = e as HttpException;
  const body = he.getResponse() as { message?: unknown };
  return { status: he.getStatus(), key: body.message, body };
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * The service's three raw insights queries, evaluated in JS with the
 * spec's own definitions (NOT the service's helpers), plus a record of
 * the SQL text so the predicates themselves can be asserted.
 */
function withRawInsights(prisma: any) {
  const sqls: { sql: string; vals: any[] }[] = [];
  prisma.$queryRaw = jest.fn(async (strings: TemplateStringsArray, ...vals: any[]) => {
    const sql = norm(strings.join("?"));
    sqls.push({ sql, vals });
    const [ws, campaignId] = vals;
    const rows = (prisma.db.campaignRecipient as any[]).filter((r) => r.workspaceId === ws && r.campaignId === campaignId);
    if (sql.includes('"readAt" - "sentAt"')) {
      const out = { withinHour: 0, oneToSix: 0, sixToDay: 0, afterDay: 0 };
      for (const r of rows) {
        if (!["read", "replied"].includes(r.status) || !r.sentAt || !r.readAt) continue;
        const d = r.readAt.getTime() - r.sentAt.getTime();
        if (d < HOUR) out.withinHour++;
        else if (d < 6 * HOUR) out.oneToSix++;
        else if (d < 24 * HOUR) out.sixToDay++;
        else out.afterDay++;
      }
      return [out];
    }
    if (sql.includes('GROUP BY "buttonPayload"')) {
      const g = new Map<string | null, any[]>();
      for (const r of rows.filter((x) => x.status === "replied")) g.set(r.buttonPayload, [...(g.get(r.buttonPayload) ?? []), r]);
      return [...g.entries()].map(([payload, list]) => ({
        payload,
        label: [...list].sort((a, b) => b.repliedAt - a.repliedAt)[0].replyText,
        count: list.length,
      }));
    }
    if (sql.includes('GROUP BY "failureCode"')) {
      const g = new Map<string | null, any[]>();
      for (const r of rows.filter((x) => ["failed", "skipped"].includes(x.status))) g.set(r.failureCode, [...(g.get(r.failureCode) ?? []), r]);
      return [...g.entries()].map(([code, list]) => ({
        code,
        reason: [...list].filter((r) => r.failureReason).sort((a, b) => b.updatedAt - a.updatedAt)[0]?.failureReason ?? null,
        count: list.length,
      }));
    }
    throw new Error(`unexpected SQL ${sql}`);
  });
  return sqls;
}

let seq = 0;
function rec(campaignId: string, over: Record<string, any> = {}) {
  seq++;
  return {
    id: `r${String(seq).padStart(6, "0")}`,
    workspaceId: WS,
    campaignId,
    contactId: null,
    channelId: null,
    phone: `+96650000${String(seq).padStart(4, "0")}`,
    contactName: `Name ${seq}`,
    status: "queued",
    messageId: null,
    sentAt: null,
    deliveredAt: null,
    readAt: null,
    repliedAt: null,
    replyText: null,
    buttonPayload: null,
    replyMessageId: null,
    failureCode: null,
    failureReason: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

function setup(recipients: any[] = [], extra: Record<string, any[]> = {}) {
  const prisma: any = makeFakePrisma({
    workspace: [{ id: WS, lang: "en", name: "A" }, { id: "ws_b", lang: "ar", name: "B" }],
    campaign: [
      { id: "c1", workspaceId: WS, name: "Spring Sale", status: "completed", recipientTracking: true, recipients: 0, sent: 0, delivered: 0, read: 0, replied: 0, failed: 0, skipped: 0, recipientsSyncedAt: at(HOUR), statsSyncedAt: at(2 * HOUR) },
      { id: "old", workspaceId: WS, name: "Old", status: "completed", recipientTracking: false, recipients: 100, sent: 90, delivered: 80, read: 50, replied: 5, failed: 4, skipped: 6, recipientsSyncedAt: null, statsSyncedAt: at(0) },
      { id: "cb", workspaceId: "ws_b", name: "B camp", status: "completed", recipientTracking: true },
    ],
    campaignRecipient: recipients,
    ...extra,
  });
  const sqls = withRawInsights(prisma);
  return { prisma, sqls, svc: new CampaignReportService(prisma) };
}

describe("CampaignReportService.recipients", () => {
  it("maps rows to RecipientDto: current contact name else snapshot, short failure title, channel once per page", async () => {
    const rows = [
      rec("c1", { contactId: "k1", channelId: "ch1", status: "read", sentAt: at(0), readAt: at(MIN) }),
      rec("c1", { contactId: "k_gone", contactName: "Snapshot", status: "failed", failureCode: "meta:131026", failureReason: "Message undeliverable" }),
      rec("c1", { status: "failed", channelId: "ch1", failureCode: "provider:unknown", failureReason: "{\"error\": \"x\"}" }),
    ];
    const { svc, prisma } = setup(rows, {
      contact: [{ id: "k1", workspaceId: WS, name: "Sara Now" }],
      channel: [{ id: "ch1", workspaceId: WS, displayName: "Main", phoneNumber: "+966500000001", kind: "whatsapp", provider: "zernio" }],
    });
    const res = await svc.recipients(WS, "c1", {});
    expect(res.tracked).toBe(true);
    expect(res.nextCursor).toBeNull();
    expect(res.items.map((i) => i.name)).toEqual(["Sara Now", "Snapshot", rows[2].contactName]);
    expect(res.items[0]).toEqual({
      id: rows[0].id,
      contactId: "k1",
      name: "Sara Now",
      phone: rows[0].phone,
      status: "read",
      sentAt: at(0).toISOString(),
      deliveredAt: null,
      readAt: at(MIN).toISOString(),
      repliedAt: null,
      replyText: null,
      buttonPayload: null,
      replyMessageId: null,
      failureCode: null,
      failureTitle: null,
      channel: { id: "ch1", displayName: "Main", phoneNumber: "+966500000001" },
    });
    expect(res.items[1].failureTitle).toBe("Message undeliverable");
    expect(res.items[2].failureTitle).toBeNull(); // has a `{`: never shown raw
    expect(prisma.channel.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.channel.findMany.mock.calls[0][0].where).toEqual({ workspaceId: WS, id: { in: ["ch1"] } });
    expect(prisma.contact.findMany.mock.calls[0][0].where).toEqual({ workspaceId: WS, id: { in: ["k1", "k_gone"] } });
  });

  it("an untracked campaign returns tracked:false and no rows, without querying recipients", async () => {
    const { svc, prisma } = setup([rec("old", { status: "read" })]);
    await expect(svc.recipients(WS, "old", {})).resolves.toEqual({ tracked: false, items: [], nextCursor: null });
    expect(prisma.campaignRecipient.findMany).not.toHaveBeenCalled();
  });
});

describe("insights buckets read times and groups replies and failures", () => {
  it("buckets read times at the 59 min, 1 h, 5 h 59 min, 6 h, 23 h 59 min and 24 h boundaries; a read before its send is in the first", async () => {
    const read = (ms: number, status = "read") => rec("c1", { status, sentAt: at(0), readAt: at(ms) });
    const rows = [
      read(59 * MIN),
      read(HOUR),
      read(5 * HOUR + 59 * MIN),
      read(6 * HOUR, "replied"),
      read(23 * HOUR + 59 * MIN),
      read(24 * HOUR),
      read(-5 * MIN), // clock skew: read stamped before send
      rec("c1", { status: "read", sentAt: null, readAt: at(0) }), // no sentAt: not bucketed
      rec("c1", { status: "delivered", sentAt: at(0), deliveredAt: at(1) }),
    ];
    const { svc, sqls } = setup(rows);
    const res = await svc.insights(WS, "c1");
    expect(res.readTiming).toEqual({ withinHour: 2, oneToSix: 2, sixToDay: 2, afterDay: 1 });
    const sql = sqls.find((s) => s.sql.includes('"readAt" - "sentAt"'))!;
    expect(sql.vals.slice(0, 2)).toEqual([WS, "c1"]);
    expect(sql.sql).toContain(`FILTER (WHERE "readAt" - "sentAt" < interval '1 hour')`);
    expect(sql.sql).toContain(`FILTER (WHERE "readAt" - "sentAt" >= interval '1 hour' AND "readAt" - "sentAt" < interval '6 hours')`);
    expect(sql.sql).toContain(`FILTER (WHERE "readAt" - "sentAt" >= interval '6 hours' AND "readAt" - "sentAt" < interval '24 hours')`);
    expect(sql.sql).toContain(`FILTER (WHERE "readAt" - "sentAt" >= interval '24 hours')`);
    expect(sql.sql).toContain(`WHERE "workspaceId" = ? AND "campaignId" = ? AND "status" IN ('read', 'replied') AND "sentAt" IS NOT NULL AND "readAt" IS NOT NULL`);
  });

  it("reply lines sort largest first with typed replies last; each label is the latest text", async () => {
    const reply = (payload: string | null, text: string, ms: number) =>
      rec("c1", { status: "replied", buttonPayload: payload, replyText: text, repliedAt: at(ms) });
    const rows = [
      reply(null, "typed 1", 1), reply(null, "typed 2", 2), reply(null, "typed 3", 3), reply(null, "typed 4", 4),
      reply("YES", "Yes", 1), reply("YES", "Yes please", 9),
      reply("NO", "No", 5), reply("NO", "No", 6), reply("NO", "No thanks", 7),
      reply("STOP", "Stop", 1),
    ];
    const { svc, sqls } = setup(rows);
    const res = await svc.insights(WS, "c1");
    expect(res.replies).toEqual([
      { payload: "NO", label: "No thanks", count: 3 },
      { payload: "YES", label: "Yes please", count: 2 },
      { payload: "STOP", label: "Stop", count: 1 },
      { payload: null, label: null, count: 4 },
    ]);
    const q = sqls.find((s) => s.sql.includes('GROUP BY "buttonPayload"'))!;
    const sql = q.sql;
    // m1: the label is the latest row per payload (DISTINCT ON), never a full array_agg.
    expect(sql).not.toContain("array_agg");
    expect(sql).toContain(`SELECT DISTINCT ON ("buttonPayload") "buttonPayload", "replyText"`);
    expect(sql).toContain(`ORDER BY "buttonPayload", "repliedAt" DESC NULLS LAST, "id" DESC`);
    expect(sql).toContain(`IS NOT DISTINCT FROM`);
    expect(sql).toContain(`WHERE "workspaceId" = ? AND "campaignId" = ? AND "status" = 'replied'`);
    expect(q.vals).toEqual([WS, "c1", WS, "c1"]);
  });

  it("failure lines group by code, null codes go to unrecorded, and lines add up to failed + skipped", async () => {
    const fail = (code: string | null, reason: string | null = null, status = "failed", ms = 0) =>
      rec("c1", { status, failureCode: code, failureReason: reason, updatedAt: at(ms) });
    const rows = [
      fail("meta:131026", "Message undeliverable", "failed", 1),
      fail("meta:131026", "Undeliverable (newer)", "failed", 2),
      fail("meta:999", "x".repeat(121)), // too long: no title
      fail("skip:opted_out", null, "skipped"),
      fail("skip:opted_out", null, "skipped"),
      fail("skip:opted_out", null, "skipped"),
      fail("skip:no_phone", null, "skipped"),
      fail(null),
      fail(null),
      rec("c1", { status: "replied", failureCode: "meta:131026" }), // a reply proves arrival: not a failure line
    ];
    const { svc, sqls } = setup(rows);
    const res = await svc.insights(WS, "c1");
    expect(res.failures).toEqual([
      { code: "skip:opted_out", title: null, count: 3 },
      { code: "meta:131026", title: "Undeliverable (newer)", count: 2 },
      { code: "meta:999", title: null, count: 1 },
      { code: "skip:no_phone", title: null, count: 1 },
    ]);
    expect(res.unrecorded).toBe(2);
    const lines = res.failures.reduce((s, f) => s + f.count, 0) + res.unrecorded;
    expect(lines).toBe(res.counts.failed + res.counts.skipped);
    const fq = sqls.find((s) => s.sql.includes('GROUP BY "failureCode"'))!;
    expect(fq.sql).toContain(`WHERE "workspaceId" = ? AND "campaignId" = ? AND "status" IN ('failed', 'skipped')`);
    // m1: latest non-null reason per code through DISTINCT ON.
    expect(fq.sql).not.toContain("array_agg");
    expect(fq.sql).toContain(`SELECT DISTINCT ON ("failureCode") "failureCode", "failureReason"`);
    expect(fq.sql).toContain(`AND "failureReason" IS NOT NULL ORDER BY "failureCode", "updatedAt" DESC, "id" DESC`);
    expect(fq.vals).toEqual([WS, "c1", WS, "c1"]);
  });

  it("counts every status, builds the funnel from the one-outcome-per-row sets, and returns sync times", async () => {
    const statuses = { queued: 2, sent: 3, delivered: 4, read: 5, replied: 6, failed: 7, skipped: 8 };
    const rows = Object.entries(statuses).flatMap(([status, n]) => Array.from({ length: n }, () => rec("c1", { status })));
    rows.push(rec("cb", { status: "read", workspaceId: "ws_b" }), rec("old", { status: "read" }));
    const { svc, prisma } = setup(rows);
    const res = await svc.insights(WS, "c1");
    expect(res.tracked).toBe(true);
    expect(res.total).toBe(35);
    expect(res.counts).toEqual(statuses);
    expect(res.funnel).toEqual({
      targeted: 35 - 8,
      sent: 3 + 4 + 5 + 6 + 7,
      delivered: 4 + 5 + 6,
      read: 5 + 6,
      replied: 6,
    });
    expect(res.recipientsSyncedAt).toBe(at(HOUR).toISOString());
    expect(res.statsSyncedAt).toBe(at(2 * HOUR).toISOString());
    expect(prisma.campaignRecipient.groupBy.mock.calls[0][0]).toEqual({
      by: ["status"],
      where: { workspaceId: WS, campaignId: "c1" },
      _count: { _all: true },
    });
  });

  it("an untracked campaign: tracked:false, funnel from the Campaign counters, empty lists, no row queries", async () => {
    const { svc, prisma } = setup();
    const res = await svc.insights(WS, "old");
    expect(res).toEqual({
      tracked: false,
      total: 0,
      counts: { queued: 0, sent: 0, delivered: 0, read: 0, replied: 0, failed: 0, skipped: 0 },
      funnel: { targeted: 100, sent: 94, delivered: 80, read: 50, replied: 5 },
      readTiming: { withinHour: 0, oneToSix: 0, sixToDay: 0, afterDay: 0 },
      replies: [],
      failures: [],
      unrecorded: 0,
      recipientsSyncedAt: null,
      statsSyncedAt: at(0).toISOString(),
    });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.campaignRecipient.groupBy).not.toHaveBeenCalled();
  });
});

class FakeRes extends EventEmitter {
  headers: Record<string, string> = {};
  chunks: string[] = [];
  statusCode = 0;
  headersSent = false;
  writableEnded = false;
  ended = false;
  abortAfter = Infinity;
  status(c: number) { this.statusCode = c; return this; }
  setHeader(k: string, v: string) { this.headers[k] = v; }
  write(c: string) {
    this.headersSent = true;
    this.chunks.push(c);
    if (this.chunks.length >= this.abortAfter) this.emit("close");
    return true;
  }
  end() { this.ended = true; this.writableEnded = true; this.emit("close"); }
  destroy() {}
  body() { return Buffer.from(this.chunks.join(""), "utf8"); }
}

const permReq = { user: { workspaceId: WS }, permissions: { permissions: { campaigns: ["view"], contacts: ["manage"] } } };

function parseCsv(text: string): string[][] {
  // Minimal RFC 4180 parser for assertions.
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\r" && text[i + 1] === "\n") { row.push(cell); out.push(row); row = []; cell = ""; i++; }
    else cell += ch;
  }
  return out;
}

describe("campaign export escapes formulas and starts with BOM", () => {
  function exportSetup() {
    const rows = [
      rec("c1", { contactName: '=HYPERLINK("x")', status: "read", sentAt: at(0), readAt: at(HOUR), channelId: "ch1" }),
      rec("c1", { contactName: "سارة العتيبي", status: "failed", failureCode: "meta:131026", failureReason: "Undeliverable" }),
      rec("c1", { contactName: "Omar", status: "failed", failureCode: "meta:4242", failureReason: "Some short reason" }),
      rec("c1", { contactName: "Lina", status: "replied", replyText: "+1 yes", buttonPayload: "YES", repliedAt: at(2 * HOUR) }),
      rec("c1", { contactName: "Skip", status: "skipped", phone: null, failureCode: "skip:opted_out" }),
      rec("cb", { workspaceId: "ws_b", contactName: "Foreign", status: "failed" }),
    ];
    const s = setup(rows, {
      channel: [{ id: "ch1", workspaceId: WS, displayName: "Main", phoneNumber: "+966500000001", kind: "whatsapp", provider: "zernio" }],
    });
    const ctrl = new CampaignReportController(s.svc, {} as never);
    return { ...s, rows, ctrl };
  }

  it("starts with EF BB BF, escapes formulas, keeps Arabic, and has an ASCII filename", async () => {
    const { ctrl } = exportSetup();
    const res = new FakeRes();
    await ctrl.exportGet(WS, "c1", { lang: "en" }, res as never, permReq as never);
    const buf = res.body();
    expect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = buf.subarray(3).toString("utf8");
    expect(text).toContain(`"'=HYPERLINK(""x"")"`);
    const lines = parseCsv(text);
    expect(lines[0]).toEqual([
      "Name", "Phone", "Status", "Sent at", "Delivered at", "Read at", "Replied at", "Reply", "Button",
      "Failure code", "Failure reason", "Sending number",
    ]);
    expect(lines).toHaveLength(6); // header + 5 rows, never the foreign workspace's
    expect(lines[1][0]).toBe(`'=HYPERLINK("x")`);
    expect(lines[1][2]).toBe("Read");
    expect(lines[1][3]).toBe(at(0).toISOString());
    expect(lines[1][11]).toBe("Main (+966500000001)");
    expect(lines[2][0]).toBe("سارة العتيبي");
    expect(lines[2][9]).toBe("meta:131026");
    expect(lines[2][10]).toBe("Message undeliverable");
    expect(lines[3][10]).toBe("WhatsApp error 4242: Some short reason");
    expect(lines[4][7]).toBe("'+1 yes");
    expect(lines[5][10]).toBe("Opted out of marketing");
    expect(res.headers["Content-Type"]).toBe("text/csv; charset=utf-8");
    const cd = res.headers["Content-Disposition"];
    expect(cd).toMatch(/^attachment; filename="campaign-spring-sale-all-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(/^[\x20-\x7e]+$/.test(cd)).toBe(true);
    expect(res.ended).toBe(true);
  });

  it("writes the header in lang=ar (and defaults to the workspace lang)", async () => {
    const { ctrl, prisma } = exportSetup();
    const res = new FakeRes();
    await ctrl.exportGet(WS, "c1", { lang: "ar" }, res as never, permReq as never);
    const lines = parseCsv(res.body().subarray(3).toString("utf8"));
    expect(lines[0][0]).toBe("الاسم");
    expect(lines[0]).toHaveLength(12);
    expect(lines[1][2]).toBe("قُرئت");
    expect(lines[2][10]).toBe("تعذر توصيل الرسالة");

    prisma.db.workspace[0].lang = "ar";
    const res2 = new FakeRes();
    await ctrl.exportGet(WS, "c1", {}, res2 as never, permReq as never);
    expect(parseCsv(res2.body().subarray(3).toString("utf8"))[0][0]).toBe("الاسم");
  });

  it("an Arabic campaign name still gives an ASCII filename", async () => {
    const { ctrl, prisma } = exportSetup();
    prisma.db.campaign[0].name = "حملة الربيع";
    const res = new FakeRes();
    await ctrl.exportGet(WS, "c1", { status: "failed" }, res as never, permReq as never);
    expect(res.headers["Content-Disposition"]).toMatch(/^attachment; filename="campaign-c1-failed-\d{4}-\d{2}-\d{2}\.csv"$/);
  });

  it("status=failed exports only failed rows; ids exports exactly those rows", async () => {
    const { ctrl, rows } = exportSetup();
    const res = new FakeRes();
    await ctrl.exportGet(WS, "c1", { status: "failed" }, res as never, permReq as never);
    const lines = parseCsv(res.body().subarray(3).toString("utf8"));
    expect(lines.slice(1).map((l) => l[0])).toEqual(["سارة العتيبي", "Omar"]);

    const res2 = new FakeRes();
    // A foreign-campaign id is silently absent (the scope is workspaceId + campaignId + id IN ids).
    await ctrl.exportPost(WS, "c1", { ids: [rows[3].id, rows[0].id, rows[5].id] }, res2 as never, permReq as never);
    const l2 = parseCsv(res2.body().subarray(3).toString("utf8"));
    expect(l2.slice(1).map((l) => l[0])).toEqual([`'=HYPERLINK("x")`, "Lina"]);
    expect(res2.headers["Content-Disposition"]).toMatch(/campaign-spring-sale-selected-/);
  });

  it("more than 10 000 ids is 400 campaigns.ids_too_many, before any byte", async () => {
    const { svc } = exportSetup();
    const ids = Array.from({ length: 10_001 }, (_, i) => `x${i}`);
    await expect(svc.prepareExport(WS, "c1", { ids }).catch(errKey)).resolves.toMatchObject({
      status: 400,
      key: "campaigns.ids_too_many",
    });
  });

  it("streams keyset batches of 1000 and stops after the current batch on abort", async () => {
    const many = Array.from({ length: 2500 }, () => rec("c1", { status: "sent" }));
    const { svc, prisma } = setup(many);
    const job = await svc.prepareExport(WS, "c1", {});
    const writes: string[] = [];
    let aborted = false;
    await job.run({
      write: (c) => {
        writes.push(c);
        if (writes.length === 2) aborted = true; // header, first batch, then the client leaves
      },
      aborted: () => aborted,
    });
    expect(prisma.campaignRecipient.findMany).toHaveBeenCalledTimes(1);
    expect(writes).toHaveLength(2);

    const full = await svc.prepareExport(WS, "c1", { status: "sent" });
    const out: string[] = [];
    const r = await full.run({ write: (c) => void out.push(c), aborted: () => false });
    expect(r.rows).toBe(2500);
    const calls = prisma.campaignRecipient.findMany.mock.calls.slice(1).map((c: any[]) => c[0]);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({ where: { workspaceId: WS, campaignId: "c1", status: "sent" }, orderBy: { id: "asc" }, take: EXPORT_BATCH });
    expect(calls[1].where.id).toEqual({ gt: many[999].id });
    expect(calls[2].where.id).toEqual({ gt: many[1999].id });
    expect(EXPORT_BATCH).toBe(1000);
  });

  it("export also asserts campaigns.view on the request", async () => {
    const { ctrl } = exportSetup();
    const noView = { user: { workspaceId: WS }, permissions: { permissions: { campaigns: [], contacts: ["manage"] } } };
    await expect(
      ctrl.exportGet(WS, "c1", {}, new FakeRes() as never, noView as never).catch((e) => e.getStatus()),
    ).resolves.toBe(403);
  });
});
