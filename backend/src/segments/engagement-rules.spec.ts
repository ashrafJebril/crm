/**
 * SP-16 Task 2 (B6, ruling 12): campaign-engagement and follow-up rules,
 * evaluated over SP-12 recipient rows and SP-04 activities.
 */
import { audienceErrorBody } from "./audience-errors";
import type { AudienceNode, AudienceRules, CampaignRuleOp, FollowUpRuleOp } from "./audience-rules";
import { createAudienceDb, evaluateContacts, type Row } from "./audience-test-db";
import { NOW, predicateWorld, WS } from "./__fixtures__/audience-world";
import { SegmentsService } from "./segments.service";

const tree = (...rules: AudienceNode[]): AudienceRules => ({ v: 2, op: "and", rules });
const H = 3_600_000;
const D = 24 * H;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

function rec(id: string, contactId: string | null, over: Row): Row {
  return { id, workspaceId: WS, campaignId: "C2", contactId, status: "queued", sentAt: null, deliveredAt: null, readAt: null, repliedAt: null, ...over };
}

/** predicateWorld plus campaign C2 with every status and timestamp mix (a1..a5 in WS). */
function world() {
  const t = predicateWorld();
  t.campaign.push({ id: "C2", workspaceId: WS });
  t.campaignRecipient.push(
    rec("q1", "a1", { status: "delivered", deliveredAt: ago(D) }), // delivered, no sentAt recorded
    rec("q2", "a2", { status: "read", readAt: ago(H) }), // read only
    rec("q3", "a3", { status: "replied", repliedAt: ago(H) }), // replied only
    rec("q4", "a4", { status: "failed", failureCode: "131026" }),
    rec("q5", "a5", { status: "queued" }), // never left
    rec("q0", null, { status: "replied", sentAt: ago(D), readAt: ago(H), repliedAt: ago(H) }), // a deleted contact
  );
  // A follow-up due exactly at `now`: open, but not overdue (dueAt < now).
  t.activity.push({ id: "act4", workspaceId: WS, contactId: "a4", doneAt: null, dueAt: new Date(NOW.getTime()) });
  // Another workspace's open, overdue activity on a WS contact id never counts.
  t.activity.push({ id: "actB", workspaceId: "wsB", contactId: "a5", doneAt: null, dueAt: ago(D) });
  const fake = createAudienceDb(t);
  const svc = new SegmentsService(fake.prisma as never);
  const run = async (r: AudienceNode) => {
    const c = await svc.compile(WS, tree(r), { now: NOW });
    return { ids: evaluateContacts(fake.db, c.where), issues: c.issues };
  };
  return { fake, db: fake.db, svc, run };
}

async function bodyOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return { status: (e as { getStatus?: () => number }).getStatus?.(), ...audienceErrorBody(e) };
  }
  throw new Error("expected a rejection");
}

describe("engagement rules use recipient timestamps and open follow-ups", () => {
  it.each<[CampaignRuleOp, string[]]>([
    // received = sent | delivered | read | replied timestamps.
    ["received", ["a1", "a2", "a3"]],
    ["read", ["a2", "a3"]],
    ["replied", ["a3"]],
    // not_replied = received (sent | delivered | read) and no repliedAt.
    ["not_replied", ["a1", "a2"]],
    ["failed", ["a4"]],
  ])("campaign %s → %j (a recipient row with a null contact never matches)", async (op, expected) => {
    const w = world();
    const r = await w.run({ field: "campaign", op, campaignId: "C2" });
    expect(r.ids).toEqual(expected);
    expect(r.issues).toEqual([]);
  });

  it.each<[FollowUpRuleOp, string[]]>([
    ["open", ["a1", "a2", "a4"]],
    // a4's follow-up is due exactly at now: open, not overdue.
    ["overdue", ["a2"]],
    // Another workspace's activity on a5 does not count; a3's is done.
    ["none_open", ["a3", "a5"]],
  ])("follow_up %s → %j", async (op, expected) => {
    const w = world();
    expect((await w.run({ field: "follow_up", op })).ids).toEqual(expected);
  });

  it("a foreign campaign id → 404 audiences.reference_not_found on save and preview", async () => {
    const w = world();
    const rules = tree({ field: "campaign", op: "received", campaignId: "CB" });
    const expected = { status: 404, message: "audiences.reference_not_found", field: "campaignId", id: "CB" };
    expect(await bodyOf(w.svc.save(WS, { name: "X", rules }))).toMatchObject(expected);
    expect(await bodyOf(w.svc.preview(WS, { rules }))).toMatchObject(expected);
  });

  it("a deleted campaign → issue campaign_missing and nobody, for every operator", async () => {
    const w = world();
    const saved = await w.svc.save(WS, { name: "Replied to C2", rules: tree({ field: "campaign", op: "not_replied", campaignId: "C2" }) });
    w.db.campaign.splice(w.db.campaign.findIndex((c) => c.id === "C2"), 1);
    for (const op of ["received", "read", "replied", "not_replied", "failed"] as const) {
      const r = await w.run({ field: "campaign", op, campaignId: "C2" });
      expect(r.ids).toEqual([]);
      expect(r.issues).toEqual([{ path: [0], kind: "campaign_missing" }]);
    }
    expect(evaluateContacts(w.db, await w.svc.resolveContactWhere(WS, saved.id, { now: NOW }))).toEqual([]);
  });
});
