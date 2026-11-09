import { EventEmitter } from "events";
import { HttpException } from "@nestjs/common";
import { makeFakePrisma } from "../channels/test-prisma";
import { CampaignReportController } from "./campaign-report.controller";
import { CampaignReportService } from "./campaign-report.service";
import { CampaignFollowUpService } from "./campaign-follow-up.service";

/* eslint-disable @typescript-eslint/no-explicit-any */

class FakeRes extends EventEmitter {
  headers: Record<string, string> = {};
  chunks: string[] = [];
  headersSent = false;
  writableEnded = false;
  status() { return this; }
  setHeader(k: string, v: string) { this.headers[k] = v; }
  write(c: string) { this.headersSent = true; this.chunks.push(c); return true; }
  end() { this.writableEnded = true; this.emit("close"); }
  destroy() {}
}

const A = "ws_a";
const req = { user: { workspaceId: A }, permissions: { permissions: { campaigns: ["view"], contacts: ["manage"] } } };

function setup() {
  const prisma: any = makeFakePrisma({
    workspace: [{ id: A, lang: "en" }, { id: "ws_b", lang: "en" }],
    campaign: [
      { id: "ca", workspaceId: A, name: "A", recipientTracking: true },
      { id: "ca2", workspaceId: A, name: "A2", recipientTracking: true },
      { id: "cb", workspaceId: "ws_b", name: "B", recipientTracking: true },
    ],
    campaignRecipient: [
      { id: "ra1", workspaceId: A, campaignId: "ca", contactId: "k1", status: "read", phone: "+1" },
      { id: "ra2", workspaceId: A, campaignId: "ca2", contactId: "k2", status: "read", phone: "+2" },
      { id: "rb1", workspaceId: "ws_b", campaignId: "cb", contactId: "kb", status: "read", phone: "+3" },
    ],
    contact: [
      { id: "k1", workspaceId: A, name: "K1", tags: "[]" },
      { id: "k2", workspaceId: A, name: "K2", tags: "[]" },
      { id: "kb", workspaceId: "ws_b", name: "KB", tags: "[]" },
    ],
    segment: [
      { id: "ga", workspaceId: A, name: "GA", origin: "manual", filter: "{}" },
      { id: "gb", workspaceId: "ws_b", name: "GB", origin: "manual", filter: "{}" },
    ],
    segmentMember: [],
    tag: [
      { id: "ta", workspaceId: A, name: "TA" },
      { id: "tb", workspaceId: "ws_b", name: "TB" },
    ],
  });
  prisma.$queryRaw = jest.fn(async () => []);
  const tags = { assign: jest.fn(async () => ({ contactsUpdated: 1 })) };
  const outbound = { emitSegmentUpserted: jest.fn(async () => false) };
  const ctrl = new CampaignReportController(
    new CampaignReportService(prisma),
    new CampaignFollowUpService(prisma, outbound as never, tags as never),
  );
  const segmentsBefore = prisma.db.segment.length;
  const nothingApplied = () => {
    expect(prisma.db.segment.length).toBe(segmentsBefore);
    expect(prisma.db.segmentMember).toHaveLength(0);
    expect(tags.assign).not.toHaveBeenCalled();
  };
  return { prisma, ctrl, tags, nothingApplied };
}

async function caught(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    const he = e as HttpException;
    return { status: he.getStatus(), key: (he.getResponse() as { message?: unknown }).message };
  }
  throw new Error("expected a rejection");
}

describe("foreign ids return 404 on every SP-12 route", () => {
  const notFound = { status: 404, key: "campaigns.not_found" };

  it.each([
    ["GET recipients", (c: CampaignReportController) => c.recipients(A, "cb", {})],
    ["GET insights", (c: CampaignReportController) => c.insights(A, "cb")],
    ["GET export", (c: CampaignReportController) => c.exportGet(A, "cb", {}, new FakeRes() as never, req as never)],
    ["POST export", (c: CampaignReportController) => c.exportPost(A, "cb", { ids: ["rb1"] }, new FakeRes() as never, req as never)],
    ["POST follow-up/create-group", (c: CampaignReportController) => c.createGroup(A, "cb", { status: "read", name: "X" })],
    ["POST follow-up/add-to-group", (c: CampaignReportController) => c.addToGroup(A, "cb", { status: "read", groupId: "ga" })],
    ["POST follow-up/tag", (c: CampaignReportController) => c.tag(A, "cb", { status: "read", tagId: "ta" })],
  ])("%s with workspace B's campaign from A is 404 campaigns.not_found", async (_n, call) => {
    const { ctrl, nothingApplied } = setup();
    await expect(caught(call(ctrl) as Promise<unknown>)).resolves.toEqual(notFound);
    nothingApplied();
  });

  it("an unknown campaign id is 404 too", async () => {
    const { ctrl } = setup();
    await expect(caught(ctrl.insights(A, "nope"))).resolves.toEqual(notFound);
  });

  it("a foreign groupId is 404 and nothing is applied", async () => {
    const { ctrl, nothingApplied } = setup();
    await expect(caught(ctrl.addToGroup(A, "ca", { status: "read", groupId: "gb" }))).resolves.toMatchObject({ status: 404 });
    nothingApplied();
  });

  it("a foreign tagId is 404 and nothing is applied", async () => {
    const { ctrl, nothingApplied } = setup();
    await expect(caught(ctrl.tag(A, "ca", { status: "read", tagId: "tb" }))).resolves.toMatchObject({ status: 404 });
    nothingApplied();
  });

  it.each([
    ["create-group", (c: CampaignReportController, ids: string[]) => c.createGroup(A, "ca", { ids, name: "X" })],
    ["add-to-group", (c: CampaignReportController, ids: string[]) => c.addToGroup(A, "ca", { ids, groupId: "ga" })],
    ["tag", (c: CampaignReportController, ids: string[]) => c.tag(A, "ca", { ids, tagId: "ta" })],
  ])("%s with ticked ids from another campaign (or workspace) is 404 campaigns.recipient_not_found; nothing applied", async (_n, call) => {
    for (const foreign of ["ra2", "rb1", "missing"]) {
      const { ctrl, nothingApplied } = setup();
      await expect(caught(call(ctrl, ["ra1", foreign]) as Promise<unknown>)).resolves.toEqual({
        status: 404,
        key: "campaigns.recipient_not_found",
      });
      nothingApplied();
    }
  });

  it("the happy path still works with own ids (sanity for the cases above)", async () => {
    const { ctrl, prisma, tags } = setup();
    await expect(ctrl.addToGroup(A, "ca", { ids: ["ra1"], groupId: "ga" })).resolves.toEqual({ added: 1, already: 0, leftOut: 0, groupId: "ga" });
    expect(prisma.db.segmentMember).toEqual([expect.objectContaining({ segmentId: "ga", contactId: "k1" })]);
    await ctrl.tag(A, "ca", { ids: ["ra1"], tagId: "ta" });
    expect(tags.assign).toHaveBeenCalledWith(A, { contactIds: ["k1"], add: ["TA"] });
  });
});
