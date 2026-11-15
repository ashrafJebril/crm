/**
 * SP-16 Task 2 (B5, ruling 16): the HJZ outbound `ruleSummary` describes a
 * v2 rule tree in English; a legacy filter's summary is unchanged. No
 * network: `fetch` is replaced, as in marketing-outbound.service.spec.
 */
import type { AudienceNode, AudienceRules } from "./audience-rules";
import { LEGACY_SENTINEL_JSON } from "./audience-rules";
import { MarketingOutboundService } from "./marketing-outbound.service";
import { ruleSummary, RULE_SUMMARY_MAX } from "./rule-summary";
import { SegmentsService } from "./segments.service";

const tree = (op: "and" | "or", ...rules: AudienceNode[]): AudienceRules => ({ v: 2, op, rules });

describe("hjz summary describes rule trees", () => {
  it("one English sentence per rule, joined with AND / OR, nested groups in parentheses", () => {
    const t = tree(
      "and",
      { field: "last_active", op: "within", value: { amount: 7, unit: "days" } },
      { field: "channel", op: "is", channel: "whatsapp" },
      { op: "or", rules: [{ field: "tag", op: "has", tag: "VIP" }, { field: "tag", op: "has", tag: "Gold", missing: true }] },
      { field: "lifecycle", op: "not_in", values: ["churned"] },
      { field: "created", op: "more_than", value: { amount: 1, unit: "months" } },
      { field: "follow_up", op: "overdue" },
    );
    expect(ruleSummary(t)).toBe(
      'last active within the last 7 days AND has a whatsapp conversation AND (has tag "VIP" OR has tag "Gold" (missing)) AND lifecycle is none of [churned] AND created more than 1 month ago AND has an overdue follow-up',
    );
    expect(ruleSummary(tree("or", { field: "conversations", op: "none" }, { field: "group", op: "not_in", segmentId: "seg_1" }))).toBe(
      "has no conversations OR is not in audience seg_1",
    );
  });

  it("every rule kind has a sentence", () => {
    const rules: AudienceNode[] = [
      { field: "tag", op: "not_has", tag: "X" },
      { field: "not_a_lead", op: "is" },
      { field: "last_active", op: "more_than", value: { amount: 2, unit: "weeks" } },
      { field: "conversations", op: "any" },
      { field: "channel", op: "is_not", channel: "telegram" },
      { field: "group", op: "in", segmentId: "g1" },
      { field: "created", op: "before", date: "2026-01-01" },
      { field: "created", op: "after", date: "2026-02-01" },
      { field: "pipeline_stage", op: "in", pipelineId: "p1", stageId: "s1" },
      { field: "pipeline_stage", op: "not_in", pipelineId: "p1" },
      { field: "custom_field", op: "eq", defId: "d1", value: "Gold" },
      { field: "custom_field", op: "set", defId: "d2" },
      { field: "campaign", op: "not_replied", campaignId: "c1" },
      { field: "follow_up", op: "none_open" },
      { field: "industry", op: "in", values: ["retail"] },
      { field: "name", op: "contains", value: "Sara" },
      { field: "phone", op: "unset" },
      { field: "stage_key", op: "in", keys: ["won"] },
    ];
    // A larger cap here: the full sentence list is longer than the 500-char payload cap.
    const s = ruleSummary(tree("and", ...rules), 5000)!;
    expect(s.split(" AND ")).toEqual([
      'does not have tag "X"',
      "is marked not a lead",
      "not active in the last 2 weeks",
      "has at least one conversation",
      "has no telegram conversation",
      "is in audience g1",
      "created before 2026-01-01",
      "created after 2026-02-01",
      "has a card in stage s1 of pipeline p1",
      "has no card in pipeline p1 (open)",
      'custom field d1 equals "Gold"',
      "custom field d2 is set",
      "did not reply to campaign c1",
      "has no open follow-up",
      "industry is one of [retail]",
      'name contains "Sara"',
      "has no phone number",
      "has a deal in stage [won]",
    ]);
    expect(s).not.toMatch(/unknown condition/);
  });

  it("is at most 500 characters; an empty tree has no summary (as legacy {})", () => {
    const many = Array.from({ length: 30 }, (_, i): AudienceNode => ({ field: "tag", op: "has", tag: `A very long tag name number ${i}` }));
    const s = ruleSummary(tree("or", ...many))!;
    expect(RULE_SUMMARY_MAX).toBe(500);
    expect(s.length).toBe(500);
    expect(s.endsWith("…")).toBe(true);
    expect(ruleSummary(tree("and"))).toBeNull();
  });

  describe("through emitSegmentUpserted (fetch replaced)", () => {
    const realFetch = global.fetch;
    let bodies: any[];
    beforeEach(() => {
      process.env.HJZ_OUTBOUND_URL = "http://test.local/api/v1/webhooks/marketing/segments";
      process.env.HJZ_WEBHOOK_SECRET = "shared-secret";
      bodies = [];
      global.fetch = jest.fn(async (_url: unknown, init: any) => {
        bodies.push(JSON.parse(init.body));
        return { ok: true, status: 200, json: async () => ({}) } as any;
      }) as any;
    });
    afterEach(() => {
      global.fetch = realFetch;
      delete process.env.HJZ_OUTBOUND_URL;
      delete process.env.HJZ_WEBHOOK_SECRET;
    });

    const svcFor = (row: Record<string, unknown>) => {
      const prisma: any = {
        workspace: { findUnique: jest.fn().mockResolvedValue({ id: "ws-1", externalTenantId: "hjz-tenant-1", timezone: "UTC" }) },
        segment: { findFirst: jest.fn().mockResolvedValue({ workspaceId: "ws-1", origin: "crm", name: "N", ...row }), findMany: jest.fn().mockResolvedValue([]) },
        pipeline: { findMany: jest.fn().mockResolvedValue([]) },
        ticketStage: { findMany: jest.fn().mockResolvedValue([]) },
        customFieldDef: { findMany: jest.fn().mockResolvedValue([]) },
        campaign: { findMany: jest.fn().mockResolvedValue([]) },
        contact: { findMany: jest.fn().mockResolvedValue([{ hjzClientId: "c-a" }]) },
      };
      return new MarketingOutboundService(prisma, new SegmentsService(prisma));
    };

    it("a v2 audience sends its rule summary", async () => {
      const svc = svcFor({
        id: "s2",
        filter: LEGACY_SENTINEL_JSON,
        rules: tree("and", { field: "last_active", op: "within", value: { amount: 7, unit: "days" } }, { field: "channel", op: "is", channel: "whatsapp" }),
      });
      expect(await svc.emitSegmentUpserted("ws-1", "s2")).toBe(true);
      expect(bodies[0].segment.ruleSummary).toBe("last active within the last 7 days AND has a whatsapp conversation");
    });

    it("a legacy audience's summary is unchanged", async () => {
      const svc = svcFor({ id: "s1", rules: null, filter: JSON.stringify({ lifecycle: ["lead"], tagsAny: ["VIP", "Gold"] }) });
      await svc.emitSegmentUpserted("ws-1", "s1");
      expect(bodies[0].segment.ruleSummary).toBe("lifecycle in [lead]; tagsAny: VIP, Gold");
      expect(svc.summarizeFilter({ source: ["wa"], tagsAll: ["A"] })).toBe("source in [wa]; tagsAll: A");
      expect(svc.summarizeFilter({})).toBeNull();
    });
  });
});
