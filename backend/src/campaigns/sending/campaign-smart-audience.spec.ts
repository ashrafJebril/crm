/**
 * SP-16 Task 2 (F1, Review Focus 5): campaigns reach the right people.
 * A smart audience resolves through the same compiler as the contacts list,
 * once per launch with the plan start as `now`; manual groups are
 * unchanged; a deleted audience refuses preview and launch.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { HttpException } from "@nestjs/common";
import { ContactsService } from "../../contacts/contacts.service";
import { audienceNotFound } from "../../segments/audience-errors";
import { createAudienceDb, emptyTables, evaluateContacts } from "../../segments/audience-test-db";
import { contact as aContact, seg, WS as AWS, WS_B } from "../../segments/__fixtures__/audience-world";
import { SegmentsService } from "../../segments/segments.service";
import { AUDIENCE_PAGE, resolveCampaignAudience, streamAudience } from "./audience-stream";
import { contact, ME, world, WS } from "./launch-test-world";

const PLAN = new Date("2026-11-15T12:00:00.000Z");
const H = 3_600_000;
const D = 24 * H;
const pad = (i: number) => String(i).padStart(5, "0");

/**
 * 2 600 contacts. Every third has a WhatsApp conversation, every fifth an
 * Instagram one; their latest inbound message is i hours before the plan
 * start (so some fall inside the 7-day window and some outside). k00007 was
 * last active 7 days minus one minute before the plan start: inside at the
 * plan start, outside an hour later.
 */
function smartWorld() {
  const t = emptyTables();
  for (let i = 0; i < 2600; i++) {
    const id = `k${pad(i)}`;
    t.contact.push(aContact(id, AWS, { phone: `+9627${pad(i)}000` }));
    const channel = i % 3 === 0 ? "whatsapp" : i % 5 === 0 ? "instagram" : null;
    if (!channel) continue;
    t.conversation.push({ id: `cv${i}`, contactId: id, workspaceId: AWS, channel });
    const at = id === "k00007" ? new Date(PLAN.getTime() - 7 * D + 60_000) : new Date(PLAN.getTime() - (i % 400) * H);
    t.message.push({ id: `m${i}`, conversationId: `cv${i}`, workspaceId: AWS, from: i % 7 === 0 ? "ai" : "them", createdAt: at });
  }
  // k00007 must be a WhatsApp contact with an inbound message.
  const c7 = t.conversation.find((c) => c.contactId === "k00007");
  if (c7) c7.channel = "whatsapp";
  else t.conversation.push({ id: "cv7", contactId: "k00007", workspaceId: AWS, channel: "whatsapp" });
  t.message.push({ id: "m7x", conversationId: c7?.id ?? "cv7", workspaceId: AWS, from: "them", createdAt: new Date(PLAN.getTime() - 7 * D + 60_000) });
  // Another workspace: an identical-looking contact that must never stream.
  t.contact.push(aContact("kB", WS_B));
  t.conversation.push({ id: "cvB", contactId: "kB", workspaceId: WS_B, channel: "whatsapp" });
  t.message.push({ id: "mB", conversationId: "cvB", workspaceId: WS_B, from: "them", createdAt: PLAN });
  t.segment.push(
    seg("SMART", AWS, "crm", {
      rules: {
        v: 2,
        op: "and",
        rules: [
          { field: "last_active", op: "within", value: { amount: 7, unit: "days" } },
          { field: "channel", op: "is", channel: "whatsapp" },
        ],
      },
      filter: JSON.stringify({ stageAny: ["__sp16_rules_v2__"] }),
    }),
    seg("G", AWS, "manual"),
  );
  for (let i = 0; i < 2600; i += 4) t.segmentMember.push({ segmentId: "G", contactId: `k${pad(i)}` });
  const fake = createAudienceDb(t);
  const segments = new SegmentsService(fake.prisma as never);
  const contacts = new ContactsService(fake.prisma as never, segments);
  return { fake, db: fake.db, segments, contacts };
}

async function streamIds(w: ReturnType<typeof smartWorld>, where: any, onPage?: () => void, pageSize = AUDIENCE_PAGE) {
  const pages: string[][] = [];
  for await (const p of streamAudience(w.fake.prisma as never, AWS, where, [], pageSize)) {
    pages.push(p.contacts.map((c) => c.id));
    onPage?.();
  }
  return pages;
}

describe("campaign audience resolves smart segments like the contacts list", () => {
  afterEach(() => jest.useRealTimers());

  it("streamAudience over the resolver's where = ContactsService.listIds({segmentId}); pages ≤ 1 000, ascending; the window is fixed at the plan start", async () => {
    const w = smartWorld();
    jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick", "queueMicrotask", "setTimeout", "clearTimeout"] });
    jest.setSystemTime(PLAN);
    const listed = await w.contacts.listIds(AWS, { segmentId: "SMART" });
    expect(listed.truncated).toBe(false);
    expect(listed.ids.length).toBeGreaterThan(100);
    expect(listed.ids).toContain("k00007");

    const where = await resolveCampaignAudience(w.segments, AWS, "SMART", PLAN);
    // Advance the fake clock by an hour after every page: membership must not move.
    // (Pages of 100 here so the audience spans several; the 1 000 default is checked below.)
    const pages = await streamIds(w, where, () => jest.setSystemTime(Date.now() + H), 100);
    const ids = pages.flat();
    expect(pages.length).toBeGreaterThan(1);
    for (const p of pages) {
      expect(p.length).toBeLessThanOrEqual(1000);
      expect(p).toEqual([...p].sort());
    }
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...listed.ids].sort());
    expect(ids).not.toContain("kB");
    // Sensitivity: resolved an hour later, k00007 would have left the window.
    const later = evaluateContacts(w.db, await resolveCampaignAudience(w.segments, AWS, "SMART", new Date(PLAN.getTime() + H)));
    expect(later).not.toContain("k00007");
    expect(ids).toContain("k00007");
  });

  it("a smart audience with a broken reference streams nobody (never the workspace)", async () => {
    const w = smartWorld();
    w.db.segment.push(seg("BROKEN", AWS, "crm", { rules: { v: 2, op: "and", rules: [{ field: "group", op: "not_in", segmentId: "gone" }] } }));
    const pages = await streamIds(w, await resolveCampaignAudience(w.segments, AWS, "BROKEN", PLAN));
    expect(pages.flat()).toEqual([]);
  });
});

describe("manual group campaign audience unchanged", () => {
  it("the manual-group stream equals its SegmentMember set", async () => {
    const w = smartWorld();
    const ids = (await streamIds(w, await resolveCampaignAudience(w.segments, AWS, "G", PLAN))).flat();
    const members = w.db.segmentMember.filter((m) => m.segmentId === "G").map((m) => m.contactId).sort();
    expect(ids).toEqual(members);
  });

  it("no segment streams the whole workspace, scoped to it", async () => {
    const w = smartWorld();
    const pages = await streamIds(w, await resolveCampaignAudience(w.segments, AWS, null, PLAN));
    // The campaign stream keeps its 1 000-row keyset pages.
    expect(AUDIENCE_PAGE).toBe(1000);
    expect(pages.map((p) => p.length)).toEqual([1000, 1000, 600]);
    const ids = pages.flat();
    expect(ids).toEqual([...ids].sort());
    expect(ids).toHaveLength(2600);
    expect(ids).not.toContain("kB");
  });

  it("a launch on a manual group sends to exactly its members, resolving the audience once per plan with the plan start", async () => {
    const people = Array.from({ length: 6 }, (_, i) => contact(`c${i}`, `C${i}`, `+96279000000${i}`));
    const w = world({
      contacts: people,
      campaign: { segmentId: "G" },
      segments: [{ id: "G", workspaceId: WS, origin: "manual", filter: "{}", rules: null }],
      segmentMembers: ["c1", "c2", "c4"].map((contactId) => ({ segmentId: "G", contactId })),
    });
    w.runner.pageSize = 2;
    const before = Date.now();
    await w.launch();
    expect(w.camp()).toMatchObject({ status: "running", lastError: null });
    expect(w.rows().map((r: any) => r.contactId).sort()).toEqual(["c1", "c2", "c4"]);
    // Once at the HTTP launch (existence check), once at the plan start.
    expect(w.segments.resolveContactWhere).toHaveBeenCalledTimes(2);
    const planCall = w.segments.resolveContactWhere.mock.calls[1] as any[];
    expect(planCall[0]).toBe(WS);
    expect(planCall[1]).toBe("G");
    expect(planCall[2].now).toBeInstanceOf(Date);
    expect(planCall[2].now.getTime()).toBeGreaterThanOrEqual(before);
    // Every audience page of the plan used the same resolved where.
    const audienceCalls = w.prisma.contact.findMany.mock.calls.filter((c: any[]) => Array.isArray(c[0]?.where?.AND));
    expect(audienceCalls.length).toBeGreaterThanOrEqual(2);
    expect(new Set(audienceCalls.map((c: any[]) => c[0].where.AND[0])).size).toBe(1);
  });
});

describe("missing audience refuses preview and launch", () => {
  const keyOf = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      const r = (e as HttpException).getResponse() as Record<string, unknown>;
      return { status: (e as HttpException).getStatus(), ...r };
    }
    return null;
  };
  const people = [contact("c1", "A", "+962790000001"), contact("c2", "B", "+962790000002")];

  it("a deleted segment id → 400 campaigns.audience_missing {segmentId} on both previews and on launch; the draft is not claimed", async () => {
    const w = world({ contacts: people, campaign: { segmentId: "gone" } });
    const expected = { status: 400, statusCode: 400, message: "campaigns.audience_missing", segmentId: "gone" };
    expect(await keyOf(w.preview.preview(WS, { segmentId: "gone" }, { canViewContacts: true }))).toEqual(expected);
    expect(await keyOf(w.send.preview(WS, "gone"))).toEqual(expected);
    expect(await keyOf(w.send.launch(WS, "camp", { mode: "now" }, { userId: ME }))).toEqual(expected);
    expect(w.camp()).toMatchObject({ status: "draft" });
    expect(w.zernio.createWhatsAppBroadcast).not.toHaveBeenCalled();
    expect(w.zernio.sendTemplateToPhone).not.toHaveBeenCalled();
  });

  it("a segment of another workspace is missing too (never the whole workspace)", async () => {
    const w = world({ contacts: people, campaign: { segmentId: "GB" }, segments: [{ id: "GB", workspaceId: "ws2", origin: "manual", filter: "{}", rules: null }] });
    expect(await keyOf(w.send.launch(WS, "camp", { mode: "now" }, { userId: ME }))).toMatchObject({ status: 400, message: "campaigns.audience_missing", segmentId: "GB" });
  });

  it("a segment deleted after the launch was accepted fails the background job with lastError campaigns.audience_missing", async () => {
    const w = world({
      contacts: people,
      campaign: { segmentId: "G" },
      segments: [{ id: "G", workspaceId: WS, origin: "manual", filter: "{}", rules: null }],
      segmentMembers: [{ segmentId: "G", contactId: "c1" }],
    });
    const real = w.segments.resolveContactWhere.getMockImplementation()!;
    let n = 0;
    // The HTTP check sees the group; by the plan start it is gone.
    w.segments.resolveContactWhere.mockImplementation(async (...a: any[]) => {
      if (++n > 1) throw audienceNotFound();
      return real(...(a as [string, string]));
    });
    const res = await w.launch();
    expect(res).toMatchObject({ status: "launching" });
    expect(w.camp()).toMatchObject({ status: "failed", lastError: "campaigns.audience_missing" });
    expect(w.rows()).toHaveLength(0);
    expect(w.zernio.deliveries).toHaveLength(0);
  });
});

describe("legacy GET /campaigns/preview is bounded (review m3)", () => {
  it("streams keyset pages of at most 1 000 contacts and keeps the response shape and totals", async () => {
    // 2 500 contacts: every 10th has no phone, every 25th opted out; c02400 repeats c00000's phone (a duplicate across pages).
    const people = Array.from({ length: 2500 }, (_, i) => {
      const id = `c${String(i).padStart(5, "0")}`;
      const phone = i % 10 === 5 ? null : i === 2400 ? "+962790000000" : `+9627900${String(i).padStart(5, "0")}`;
      return contact(id, `C${i}`, phone, { marketingOptOut: i % 25 === 3 });
    });
    const w = world({ contacts: people });
    const res = await w.send.preview(WS, null);
    const noPhone = people.filter((p) => !p.phone).length;
    const optedOut = people.filter((p) => p.phone && p.marketingOptOut).length;
    expect(res).toEqual({
      total: 2500,
      reachable: 2500 - noPhone - optedOut - 1,
      skipped: { noPhone, optedOut, duplicate: 1 },
      estimate: { usd: expect.any(Number), unpriced: 0 },
    });
    const calls = w.prisma.contact.findMany.mock.calls.map((c: any[]) => c[0]);
    expect(calls.length).toBe(3);
    for (const a of calls) {
      expect(a.take).toBeLessThanOrEqual(1000);
      expect(a.orderBy).toEqual({ id: "asc" });
    }
  });
});
