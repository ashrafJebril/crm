import { HttpException } from "@nestjs/common";
import { makeFakePrisma } from "../channels/test-prisma";
import {
  CampaignFollowUpService,
  FOLLOW_UP_CHUNK,
  FOLLOW_UP_CONTACTS_CAP,
  FOLLOW_UP_IDS_CAP,
  ROW_SCAN_BATCH,
} from "./campaign-follow-up.service";

/* eslint-disable @typescript-eslint/no-explicit-any */

const WS = "ws_a";

function errOf(e: unknown) {
  const he = e as HttpException;
  const body = he.getResponse() as Record<string, unknown>;
  return { status: he.getStatus(), key: body.message, body };
}

let seq = 0;
function row(campaignId: string, contactId: string | null, status = "read", ws = WS) {
  seq++;
  return {
    id: `r${String(seq).padStart(6, "0")}`,
    workspaceId: ws,
    campaignId,
    contactId,
    channelId: null,
    phone: `+9665${String(seq).padStart(8, "0")}`,
    contactName: null,
    status,
  };
}
const contact = (id: string, ws = WS) => ({ id, workspaceId: ws, name: id, tags: "[]" });

function setup(opts: { recipients?: any[]; contacts?: any[]; segments?: any[]; tags?: any[] } = {}) {
  const prisma: any = makeFakePrisma({
    campaign: [
      { id: "c1", workspaceId: WS, name: "C1", recipientTracking: true },
      { id: "c2", workspaceId: WS, name: "C2", recipientTracking: true },
      { id: "cb", workspaceId: "ws_b", name: "B", recipientTracking: true },
    ],
    campaignRecipient: opts.recipients ?? [],
    contact: opts.contacts ?? [],
    segment: opts.segments ?? [
      { id: "g_manual", workspaceId: WS, name: "Manual", origin: "manual", filter: "{}" },
      { id: "g_crm", workspaceId: WS, name: "Smart", origin: "crm", filter: "{}" },
      { id: "g_foreign", workspaceId: "ws_b", name: "B group", origin: "manual", filter: "{}" },
    ],
    segmentMember: [],
    tag: opts.tags ?? [
      { id: "t1", workspaceId: WS, name: "VIP", color: "30" },
      { id: "t_foreign", workspaceId: "ws_b", name: "B tag", color: "30" },
    ],
  });
  const outbound = { emitSegmentUpserted: jest.fn(async () => false) };
  const tags = { assign: jest.fn(async (_ws: string, input: { contactIds: string[] }) => ({ contactsUpdated: input.contactIds.length })) };
  return { prisma, outbound, tags, svc: new CampaignFollowUpService(prisma, outbound as never, tags as never) };
}

describe("follow-up resolves contacts per workspace and reuses group and tag services", () => {
  it("create-group from status=read creates one manual group and adds the distinct contacts in chunks of 1000", async () => {
    const contacts = Array.from({ length: 2500 }, (_, i) => contact(`k${i}`));
    const recipients = [
      ...contacts.map((c) => row("c1", c.id, "read")),
      row("c1", "k0", "read"), // same contact on a second number: added once
      row("c1", "k1", "replied"), // another outcome: not in the target
      row("c2", "k2", "read"), // another campaign
    ];
    const { svc, prisma, outbound } = setup({ recipients, contacts });
    const res = await svc.createGroup(WS, "c1", { status: "read", name: "  Readers  ", nameAr: "القراء" });
    const created = prisma.db.segment.filter((s: any) => s.name === "Readers");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ workspaceId: WS, origin: "manual", filter: "{}", nameAr: "القراء" });
    expect(res).toEqual({ added: 2500, already: 0, leftOut: 0, groupId: created[0].id });
    const calls = prisma.segmentMember.createMany.mock.calls.map((c: any[]) => c[0]);
    expect(calls.map((c: any) => c.data.length)).toEqual([FOLLOW_UP_CHUNK, FOLLOW_UP_CHUNK, 500]);
    expect(calls.every((c: any) => c.skipDuplicates === true)).toBe(true);
    expect(FOLLOW_UP_CHUNK).toBe(1000);
    // One HJZ emit for the whole action, not one per chunk.
    expect(outbound.emitSegmentUpserted).toHaveBeenCalledTimes(1);
    expect(outbound.emitSegmentUpserted).toHaveBeenCalledWith(WS, created[0].id);
    // Contacts were re-read inside the workspace.
    for (const c of prisma.contact.findMany.mock.calls) expect(c[0].where.workspaceId).toBe(WS);
    for (const c of prisma.campaignRecipient.findMany.mock.calls) {
      expect(c[0].where).toMatchObject({ workspaceId: WS, campaignId: "c1" });
    }
  });

  it("rows whose contact was deleted (null, or gone) count as leftOut", async () => {
    const recipients = [row("c1", "k1"), row("c1", null), row("c1", null), row("c1", "k_gone"), row("c1", "k_other_ws")];
    const { svc } = setup({ recipients, contacts: [contact("k1"), contact("k_other_ws", "ws_b")] });
    await expect(svc.addToGroup(WS, "c1", { status: "read", groupId: "g_manual" })).resolves.toEqual({
      added: 1,
      already: 0,
      leftOut: 4,
      groupId: "g_manual",
    });
  });

  it("add-to-group reports contacts already in the group", async () => {
    const recipients = [row("c1", "k1"), row("c1", "k2")];
    const { svc, prisma } = setup({ recipients, contacts: [contact("k1"), contact("k2")] });
    prisma.db.segmentMember.push({ segmentId: "g_manual", contactId: "k1" });
    await expect(svc.addToGroup(WS, "c1", { ids: [recipients[0].id, recipients[1].id], groupId: "g_manual" })).resolves.toEqual({
      added: 1,
      already: 1,
      leftOut: 0,
      groupId: "g_manual",
    });
  });

  it("tag resolves the tag name and calls TagsService.assign in chunks", async () => {
    const contacts = Array.from({ length: 1200 }, (_, i) => contact(`k${i}`));
    const recipients = contacts.map((c) => row("c1", c.id, "failed"));
    const { svc, tags } = setup({ recipients, contacts });
    tags.assign.mockImplementationOnce(async (_ws, input) => ({ contactsUpdated: input.contactIds.length - 10 }));
    const res = await svc.tag(WS, "c1", { status: "failed", tagId: "t1" });
    expect(tags.assign).toHaveBeenCalledTimes(2);
    expect(tags.assign.mock.calls[0][0]).toBe(WS);
    expect(tags.assign.mock.calls[0][1]).toEqual({ contactIds: contacts.slice(0, 1000).map((c) => c.id), add: ["VIP"] });
    expect((tags.assign.mock.calls[1][1] as any).contactIds).toHaveLength(200);
    expect(res).toEqual({ added: 1190, already: 10, leftOut: 0 });
  });

  it("a non-manual group is 400 and nothing is written", async () => {
    const { svc, prisma } = setup({ recipients: [row("c1", "k1")], contacts: [contact("k1")] });
    await expect(svc.addToGroup(WS, "c1", { status: "read", groupId: "g_crm" }).catch(errOf)).resolves.toMatchObject({ status: 400 });
    expect(prisma.segmentMember.createMany).not.toHaveBeenCalled();
  });

  it("more than 10 000 distinct contacts is 400 campaigns.follow_up_too_large and writes nothing", async () => {
    const n = FOLLOW_UP_CONTACTS_CAP + 1;
    const contacts = Array.from({ length: n }, (_, i) => contact(`k${i}`));
    const recipients = contacts.map((c) => row("c1", c.id, "read"));
    const { svc, prisma, tags } = setup({ recipients, contacts });
    const before = prisma.db.segment.length;
    await expect(svc.createGroup(WS, "c1", { status: "read", name: "Big" }).catch(errOf)).resolves.toMatchObject({
      status: 400,
      key: "campaigns.follow_up_too_large",
      body: { limit: 10_000, count: n },
    });
    await expect(svc.tag(WS, "c1", { status: "read", tagId: "t1" }).catch(errOf)).resolves.toMatchObject({
      key: "campaigns.follow_up_too_large",
    });
    expect(prisma.db.segment.length).toBe(before);
    expect(prisma.segmentMember.createMany).not.toHaveBeenCalled();
    expect(tags.assign).not.toHaveBeenCalled();
  });

  it("an outcome over the cap stops paging as soon as the cap is passed (m3)", async () => {
    // 30 000 distinct contacts read: the cap (10 000) is passed in the 3rd batch of 5 000.
    const recipients = Array.from({ length: 30_000 }, (_, i) => row("c1", `k${i}`, "read"));
    const { svc, prisma, tags } = setup({ recipients, contacts: [] });
    await expect(svc.tag(WS, "c1", { status: "read", tagId: "t1" }).catch(errOf)).resolves.toMatchObject({
      status: 400,
      key: "campaigns.follow_up_too_large",
      body: { limit: FOLLOW_UP_CONTACTS_CAP },
    });
    expect(ROW_SCAN_BATCH).toBe(5000);
    expect(prisma.campaignRecipient.findMany).toHaveBeenCalledTimes(Math.ceil((FOLLOW_UP_CONTACTS_CAP + 1) / ROW_SCAN_BATCH));
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
    expect(tags.assign).not.toHaveBeenCalled();
  });

  it("create-group partial failure: the error carries {groupId}, and HJZ is notified for the written members (m2)", async () => {
    const contacts = Array.from({ length: 2500 }, (_, i) => contact(`k${i}`));
    const recipients = contacts.map((c) => row("c1", c.id, "read"));
    const { svc, prisma, outbound } = setup({ recipients, contacts });
    // A contact of the 3rd chunk is deleted after resolve: addManualMembers 404s on that chunk.
    const realCreateMany = prisma.segmentMember.createMany.getMockImplementation();
    let calls = 0;
    prisma.segmentMember.createMany.mockImplementation((a: any) => {
      if (++calls === 2) prisma.db.contact = prisma.db.contact.filter((c: any) => c.id !== "k2400");
      return realCreateMany(a);
    });
    const err = await svc.createGroup(WS, "c1", { status: "read", name: "Readers" }).catch((e) => e);
    const created = prisma.db.segment.find((s: any) => s.name === "Readers");
    expect(created).toBeDefined();
    expect(err.getStatus()).toBe(404);
    expect(err.getResponse()).toMatchObject({ groupId: created.id, added: 2000 });
    expect(prisma.db.segmentMember).toHaveLength(2000);
    expect(outbound.emitSegmentUpserted).toHaveBeenCalledTimes(1);
    expect(outbound.emitSegmentUpserted).toHaveBeenCalledWith(WS, created.id);
  });

  it("create-group failing before any member is written does not notify HJZ, but still reports {groupId} (m2)", async () => {
    const recipients = [row("c1", "k1")];
    const { svc, prisma, outbound } = setup({ recipients, contacts: [contact("k1")] });
    prisma.segmentMember.createMany.mockImplementation(() => {
      throw new Error("db down");
    });
    const err = await svc.createGroup(WS, "c1", { status: "read", name: "G" }).catch((e) => e);
    const created = prisma.db.segment.find((s: any) => s.name === "G");
    expect(err.getStatus()).toBe(500);
    expect(err.getResponse()).toMatchObject({ groupId: created.id, added: 0 });
    expect(JSON.stringify(err.getResponse())).not.toContain("db down");
    expect(outbound.emitSegmentUpserted).not.toHaveBeenCalled();
  });

  it("more than 5 000 ids is 400 campaigns.ids_too_many; exactly one of status/ids is required", async () => {
    const { svc } = setup();
    const ids = Array.from({ length: FOLLOW_UP_IDS_CAP + 1 }, (_, i) => `r${i}`);
    await expect(svc.tag(WS, "c1", { ids, tagId: "t1" }).catch(errOf)).resolves.toMatchObject({ status: 400, key: "campaigns.ids_too_many" });
    expect(FOLLOW_UP_IDS_CAP).toBe(5000);
    await expect(svc.tag(WS, "c1", { tagId: "t1" }).catch(errOf)).resolves.toMatchObject({ status: 400, key: "campaigns.follow_up_target" });
    await expect(svc.tag(WS, "c1", { tagId: "t1", ids: [] }).catch(errOf)).resolves.toMatchObject({ key: "campaigns.follow_up_target" });
    await expect(svc.tag(WS, "c1", { tagId: "t1", status: "read", ids: ["x"] }).catch(errOf)).resolves.toMatchObject({
      key: "campaigns.follow_up_target",
    });
    await expect(svc.tag(WS, "c1", { tagId: "t1", status: "bogus" as never }).catch(errOf)).resolves.toMatchObject({
      key: "campaigns.invalid_status",
    });
  });

  it("a blank group name is 400 campaigns.group_name_required and creates nothing", async () => {
    const { svc, prisma } = setup({ recipients: [row("c1", "k1")], contacts: [contact("k1")] });
    const before = prisma.db.segment.length;
    await expect(svc.createGroup(WS, "c1", { status: "read", name: "   " }).catch(errOf)).resolves.toMatchObject({
      status: 400,
      key: "campaigns.group_name_required",
    });
    expect(prisma.db.segment.length).toBe(before);
  });
});
