/**
 * SP-12 Review Focus 1: keyset paging over 100 000 recipients.
 *
 * The table is an in-memory double (the test-prisma.ts pattern) kept sorted
 * by id, so a page is a binary search, like the (campaignId, id) and
 * (campaignId, status, id) indexes. The double accepts ONLY the query shape
 * those indexes serve and fails the test on anything else.
 */
import { HttpException } from "@nestjs/common";
import { CampaignReportService } from "./campaign-report.service";
import { RECIPIENT_STATUSES, type RecipientStatus } from "./tracking/recipient-status";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = { id: string; workspaceId: string; campaignId: string; status: RecipientStatus; [k: string]: any };

const WS = "ws_a";
const CAMPAIGN = "camp_1";
const N = 100_000;
const pad = (i: number) => `r${String(i).padStart(7, "0")}`;

function makeTable() {
  const rows: Row[] = [];
  for (let i = 0; i < N; i++) {
    rows.push({
      id: pad(i),
      workspaceId: WS,
      campaignId: CAMPAIGN,
      // Mixed statuses, deterministic.
      status: RECIPIENT_STATUSES[(i * 7 + (i >> 3)) % RECIPIENT_STATUSES.length],
      contactId: null,
      channelId: null,
      phone: `+9665${String(i).padStart(8, "0")}`,
      contactName: `N${i}`,
    });
  }
  // A foreign campaign and a foreign workspace interleaved by id.
  rows.push({ id: pad(50).replace("r", "q"), workspaceId: WS, campaignId: "camp_other", status: "read" });
  rows.push({ id: pad(60) + "x", workspaceId: "ws_b", campaignId: CAMPAIGN, status: "read" });
  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return rows;
}

function lowerBound(rows: Row[], id: string): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].id <= id) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function setup() {
  const rows = makeTable();
  const calls: any[] = [];
  const prisma = {
    campaign: {
      findFirst: jest.fn(async (a: any) =>
        a.where.id === CAMPAIGN && a.where.workspaceId === WS
          ? { id: CAMPAIGN, workspaceId: WS, recipientTracking: true, name: "C" }
          : null,
      ),
    },
    campaignRecipient: {
      findMany: jest.fn(async (a: any) => {
        calls.push(a);
        const { where, orderBy, take } = a;
        const keys = Object.keys(where).sort();
        const allowed = ["campaignId", "id", "status", "workspaceId"];
        if (!keys.every((k) => allowed.includes(k))) throw new Error(`unexpected where keys ${keys}`);
        if (JSON.stringify(orderBy) !== JSON.stringify({ id: "asc" })) throw new Error("unexpected orderBy");
        if (where.id !== undefined && (Object.keys(where.id).length !== 1 || typeof where.id.gt !== "string"))
          throw new Error("unexpected id filter");
        const start = where.id ? lowerBound(rows, where.id.gt) : 0;
        const out: Row[] = [];
        for (let i = start; i < rows.length && out.length < take; i++) {
          const r = rows[i];
          if (r.workspaceId !== where.workspaceId || r.campaignId !== where.campaignId) continue;
          if (where.status !== undefined && r.status !== where.status) continue;
          out.push({ ...r });
        }
        return out;
      }),
    },
    contact: { findMany: jest.fn(async () => []) },
    channel: { findMany: jest.fn(async () => []) },
  };
  return { rows, calls, prisma, svc: new CampaignReportService(prisma as never) };
}

async function pageAll(svc: CampaignReportService, status: RecipientStatus | undefined, between?: (n: number) => void) {
  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const res = await svc.recipients(WS, CAMPAIGN, { status, cursor, limit: 200 });
    expect(res.tracked).toBe(true);
    expect(res.items.length).toBeLessThanOrEqual(200);
    seen.push(...res.items.map((r) => r.id));
    pages++;
    if (!res.nextCursor) break;
    expect(res.items).toHaveLength(200);
    cursor = res.nextCursor;
    between?.(pages);
  }
  return { seen, pages };
}

const ascending = (ids: string[]) => ids.every((id, i) => i === 0 || ids[i - 1] < id);

describe("recipients-cursor: keyset paging over 100 000 rows", () => {
  jest.setTimeout(60_000);

  it("pages over all rows: every row exactly once, ascending, last nextCursor null", async () => {
    const { svc, rows } = setup();
    const { seen, pages } = await pageAll(svc, undefined);
    const expected = rows.filter((r) => r.workspaceId === WS && r.campaignId === CAMPAIGN).map((r) => r.id);
    expect(seen).toHaveLength(N);
    expect(new Set(seen).size).toBe(N);
    expect(seen).toEqual(expected);
    expect(ascending(seen)).toBe(true);
    expect(pages).toBe(N / 200);
  });

  it("pages over status=read: every read row exactly once, ascending", async () => {
    const { svc, rows } = setup();
    const expected = rows.filter((r) => r.workspaceId === WS && r.campaignId === CAMPAIGN && r.status === "read").map((r) => r.id);
    expect(expected.length).toBeGreaterThan(10_000);
    const { seen } = await pageAll(svc, "read");
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("every query has the index-served shape {where:{workspaceId, campaignId, status?, id:{gt}}, orderBy:{id:'asc'}, take: limit+1}", async () => {
    const { svc, calls } = setup();
    const { seen } = await pageAll(svc, "read");
    expect(calls.length).toBeGreaterThan(1);
    calls.forEach((c, i) => {
      const where: any = { workspaceId: WS, campaignId: CAMPAIGN, status: "read" };
      if (i > 0) where.id = { gt: seen[i * 200 - 1] };
      expect(c).toEqual({ where, orderBy: { id: "asc" }, take: 201 });
    });
    const { svc: s2, calls: c2 } = setup();
    await s2.recipients(WS, CAMPAIGN, { limit: 50 });
    expect(c2[0]).toEqual({ where: { workspaceId: WS, campaignId: CAMPAIGN }, orderBy: { id: "asc" }, take: 51 });
  });

  it("rows inserted mid-scan with higher ids appear; nothing repeats", async () => {
    const { svc, rows } = setup();
    let added = 0;
    const { seen } = await pageAll(svc, undefined, (page) => {
      if (page % 50 === 0) {
        // Higher ids, appended at the end like new cuids.
        for (let k = 0; k < 3; k++) rows.push({ id: `s${String(++added).padStart(4, "0")}`, workspaceId: WS, campaignId: CAMPAIGN, status: "queued" });
      }
    });
    expect(added).toBeGreaterThan(0);
    expect(seen).toHaveLength(N + added);
    expect(new Set(seen).size).toBe(seen.length);
    for (let k = 1; k <= added; k++) expect(seen).toContain(`s${String(k).padStart(4, "0")}`);
  });

  it("stays stable while statuses change between pages: no duplicates, rows that stay read are all seen", async () => {
    const { svc, rows } = setup();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const mine = rows.filter((r) => r.workspaceId === WS && r.campaignId === CAMPAIGN);
    const moved = new Set<string>();
    let flip = 0;
    const { seen } = await pageAll(svc, "read", () => {
      // Between pages: some read rows ahead become replied (leave the filter),
      // some delivered rows ahead become read (join it), and some rows behind
      // the cursor change too.
      for (let k = 0; k < 40; k++) {
        const r = mine[(flip = (flip + 2477) % mine.length)];
        if (r.status === "read") { r.status = "replied"; moved.add(r.id); }
        else if (r.status === "delivered") { r.status = "read"; moved.add(r.id); }
      }
    });
    expect(new Set(seen).size).toBe(seen.length);
    expect(ascending(seen)).toBe(true);
    const stayedRead = mine.filter((r) => r.status === "read" && !moved.has(r.id)).map((r) => r.id);
    const seenSet = new Set(seen);
    for (const id of stayedRead) expect(seenSet.has(id)).toBe(true);
    // Everything returned was read when returned (never a row of another filter).
    for (const id of seen) expect(["read", "replied"]).toContain(byId.get(id)!.status);
  });

  function errKey(e: unknown) {
    const he = e as HttpException;
    return { status: he.getStatus(), key: (he.getResponse() as { message?: unknown }).message };
  }

  it("a malformed cursor, or one from another status, is 400 campaigns.invalid_cursor", async () => {
    const { svc } = setup();
    await expect(svc.recipients(WS, CAMPAIGN, { cursor: "garbage!!", limit: 200 }).catch(errKey)).resolves.toEqual({
      status: 400,
      key: "campaigns.invalid_cursor",
    });
    const first = await svc.recipients(WS, CAMPAIGN, { status: "read", limit: 200 });
    expect(first.nextCursor).toBeTruthy();
    await expect(
      svc.recipients(WS, CAMPAIGN, { status: "failed", cursor: first.nextCursor!, limit: 200 }).catch(errKey),
    ).resolves.toEqual({ status: 400, key: "campaigns.invalid_cursor" });
    await expect(
      svc.recipients(WS, CAMPAIGN, { cursor: first.nextCursor!, limit: 200 }).catch(errKey),
    ).resolves.toEqual({ status: 400, key: "campaigns.invalid_cursor" });
  });

  it("limit=500 (and 0, and a fraction) is 400; an unknown status is 400", async () => {
    const { svc, prisma } = setup();
    for (const limit of [500, 201, 0, 1.5]) {
      await expect(svc.recipients(WS, CAMPAIGN, { limit }).catch(errKey)).resolves.toEqual({
        status: 400,
        key: "campaigns.invalid_limit",
      });
    }
    await expect(svc.recipients(WS, CAMPAIGN, { status: "bogus" as never }).catch(errKey)).resolves.toEqual({
      status: 400,
      key: "campaigns.invalid_status",
    });
    expect(prisma.campaignRecipient.findMany).not.toHaveBeenCalled();
  });

  it("a campaign of another workspace is 404 campaigns.not_found", async () => {
    const { svc, prisma } = setup();
    await expect(svc.recipients("ws_b", CAMPAIGN, { limit: 200 }).catch(errKey)).resolves.toEqual({
      status: 404,
      key: "campaigns.not_found",
    });
    expect(prisma.campaignRecipient.findMany).not.toHaveBeenCalled();
  });
});
