/**
 * SP-16 audience compiler (ruling 1): a rule tree → one
 * `Prisma.ContactWhereInput`, the type every audience consumer already takes.
 *
 * Pure: the lookups come in, nothing is read. A rule whose reference is gone
 * (ruling 6) compiles to `MATCH_NONE` for every operator and reports an
 * issue. Legacy fields reproduce the pre-SP-16 `buildWhere` expressions
 * exactly (and, on an `and` root, at the same position: industry, source,
 * name, phone and stage key as top-level keys, everything else in `AND`).
 */
import type { Prisma } from "@prisma/client";
import { localMidnight } from "../activities/buckets";
import { fieldWhere } from "../custom-fields/custom-fields.service";
import type { AudienceLookups } from "./audience-lookups";
import {
  AUDIENCE_LIMITS,
  isGroup,
  readRules,
  relativeSince,
  type AudienceGroup,
  type AudienceNode,
  type AudienceRule,
  type RuleIssue,
  type RuleIssueKind,
  type RelTime,
} from "./audience-rules";

/** Matches no contact (Prisma renders `1=0`). */
export const MATCH_NONE: Prisma.ContactWhereInput = Object.freeze({ id: { in: [] as string[] } }) as Prisma.ContactWhereInput;

export interface CompileCtx {
  now: Date;
  tz: string;
  lookups: AudienceLookups;
  /** Smart audiences on the current inlining path (cycle guard). */
  visited?: Set<string>;
  /** Inlining depth of referenced smart audiences. */
  depth?: number;
}

export interface CompileResult {
  where: Prisma.ContactWhereInput;
  issues: RuleIssue[];
}

/** Root keys the legacy `buildWhere` set directly (not in `AND`). */
const HOISTED_FIELDS = new Set(["industry", "source", "name", "phone", "stage_key"]);

const tagNeedle = (name: string): Prisma.ContactWhereInput => ({ tags: { contains: JSON.stringify(name) } });

/** "pipeline_stage" predicate (ruling 9): a stage → any card in it, open or closed; pipeline only → open cards. */
export function pipelineStageWhere(
  ws: string,
  ref: { pipelineId: string; stageId?: string },
  op: "in" | "not_in",
): Prisma.ContactWhereInput {
  const ticket: Prisma.TicketWhereInput = ref.stageId
    ? { workspaceId: ws, pipelineId: ref.pipelineId, stageId: ref.stageId }
    : { workspaceId: ws, pipelineId: ref.pipelineId, closedAt: null };
  return { tickets: op === "in" ? { some: ticket } : { none: ticket } };
}

function missingKind(r: AudienceRule): RuleIssueKind {
  switch (r.field) {
    case "tag":
      return "tag_deleted";
    case "group":
      return "group_missing";
    case "pipeline_stage":
      return r.stageId ? "stage_missing" : "pipeline_missing";
    case "campaign":
      return "campaign_missing";
    default:
      return "field_missing";
  }
}

export function compileAudience(ws: string, tree: AudienceGroup, ctx: CompileCtx): CompileResult {
  const issues: RuleIssue[] = [];
  const none = (path: number[], kind: RuleIssueKind): Prisma.ContactWhereInput => {
    issues.push({ path, kind });
    return MATCH_NONE;
  };

  const rule = (r: AudienceRule, path: number[]): Prisma.ContactWhereInput => {
    if (r.missing) return none(path, missingKind(r));
    switch (r.field) {
      case "tag":
        return r.op === "has" ? tagNeedle(r.tag) : { NOT: tagNeedle(r.tag) };
      case "lifecycle": {
        const any: Prisma.ContactWhereInput = {
          OR: r.values.map((v) => ({ lifecycle: { equals: v, mode: "insensitive" as const } })),
        };
        return r.op === "in" ? any : { NOT: any };
      }
      case "not_a_lead":
        return { notALead: r.op === "is" };
      case "last_active": {
        const conv: Prisma.ConversationWhereInput = {
          workspaceId: ws,
          messages: { some: { workspaceId: ws, from: "them", createdAt: { gte: relativeSince(ctx.now, r.value) } } },
        };
        return { conversations: r.op === "within" ? { some: conv } : { none: conv } };
      }
      case "conversations":
        return { conversations: r.op === "any" ? { some: { workspaceId: ws } } : { none: { workspaceId: ws } } };
      case "channel": {
        const conv: Prisma.ConversationWhereInput = { workspaceId: ws, channel: r.channel };
        return { conversations: r.op === "is" ? { some: conv } : { none: conv } };
      }
      case "created": {
        if (r.op === "within" || r.op === "more_than") {
          const since = relativeSince(ctx.now, (r as { value: RelTime }).value);
          return { createdAt: r.op === "within" ? { gte: since } : { lt: since } };
        }
        const [y, m, d] = (r as { date: string }).date.split("-").map(Number);
        if (r.op === "before") return { createdAt: { lt: localMidnight(y, m - 1, d, ctx.tz) } };
        return { createdAt: { gte: localMidnight(y, m - 1, d + 1, ctx.tz) } };
      }
      case "group":
        return group(r, path);
      case "pipeline_stage": {
        const p = ctx.lookups.pipelines.get(r.pipelineId);
        if (!p) return none(path, "pipeline_missing");
        if (p.archivedAt) return none(path, "pipeline_archived");
        if (r.stageId) {
          const s = ctx.lookups.stages.get(r.stageId);
          if (!s || s.pipelineId !== r.pipelineId) return none(path, "stage_missing");
        }
        return pipelineStageWhere(ws, r, r.op);
      }
      case "custom_field": {
        const def = ctx.lookups.defs.get(r.defId);
        if (!def || def.archivedAt) return none(path, "field_missing");
        try {
          return fieldWhere(def, r.op, r.value);
        } catch {
          // A stored value the def no longer accepts narrows to nobody (save rejects it with 400).
          return none(path, "field_missing");
        }
      }
      case "campaign": {
        if (!ctx.lookups.campaigns.has(r.campaignId)) return none(path, "campaign_missing");
        const base = { workspaceId: ws, campaignId: r.campaignId };
        const received: Prisma.CampaignRecipientWhereInput[] = [
          { sentAt: { not: null } },
          { deliveredAt: { not: null } },
          { readAt: { not: null } },
          { repliedAt: { not: null } },
        ];
        let rec: Prisma.CampaignRecipientWhereInput;
        if (r.op === "received") rec = { ...base, OR: received };
        else if (r.op === "read") rec = { ...base, OR: [{ readAt: { not: null } }, { repliedAt: { not: null } }] };
        else if (r.op === "replied") rec = { ...base, repliedAt: { not: null } };
        else if (r.op === "not_replied") rec = { ...base, repliedAt: null, OR: received.slice(0, 3) };
        else rec = { ...base, status: "failed" };
        return { campaignRecipients: { some: rec } };
      }
      case "follow_up": {
        const open: Prisma.ActivityWhereInput = { workspaceId: ws, doneAt: null };
        if (r.op === "open") return { activities: { some: open } };
        if (r.op === "overdue") return { activities: { some: { ...open, dueAt: { lt: ctx.now } } } };
        return { activities: { none: open } };
      }
      case "industry":
        return { industry: { in: r.values } };
      case "source":
        return { source: { in: r.values } };
      case "name":
        return { name: { contains: r.value.trim(), mode: "insensitive" } };
      case "phone":
        return r.op === "set" ? { phone: { not: null } } : { phone: null };
      case "stage_key":
        // Legacy, exactly as before: any ticket in a stage with one of these keys.
        return { tickets: { some: { stage: { key: { in: r.keys } } } } };
      default:
        // Unknown stored shape (corrupt data): narrow, never widen.
        return MATCH_NONE;
    }
  };

  const group = (r: Extract<AudienceRule, { field: "group" }>, path: number[]): Prisma.ContactWhereInput => {
    const seg = ctx.lookups.segments.get(r.segmentId);
    if (!seg) return none(path, "group_missing");
    let inner: Prisma.ContactWhereInput;
    if (seg.origin !== "crm") {
      inner = { segmentMembers: { some: { segmentId: seg.id } } };
      return r.op === "in" ? inner : { segmentMembers: { none: { segmentId: seg.id } } };
    }
    const visited = ctx.visited ?? new Set<string>();
    const depth = ctx.depth ?? 0;
    if (visited.has(seg.id)) return none(path, "cycle");
    // One chain bound for save, lookups, the cycle walk and here (fix I2).
    if (depth + 1 > AUDIENCE_LIMITS.maxReferenceDepth) return none(path, "too_deep");
    const sub = compileAudience(ws, readRules(seg).tree, {
      ...ctx,
      visited: new Set([...visited, seg.id]),
      depth: depth + 1,
    });
    // Fix C1: ANY issue inside the referenced audience's closure (a deleted tag,
    // a broken stage, field, campaign or group, a cycle, the depth bound) makes
    // this rule match nobody for BOTH operators. `NOT (nobody)` would otherwise
    // widen `not_in` to the whole workspace. The issue is reported here, on the
    // referencing rule, with the inner issue's kind.
    if (sub.issues.length) return none(path, sub.issues[0].kind);
    inner = sub.where;
    return r.op === "in" ? inner : { NOT: inner };
  };

  const node = (n: AudienceNode, path: number[]): Prisma.ContactWhereInput => {
    if (!isGroup(n)) return rule(n, path);
    const parts = n.rules.map((c, i) => node(c, [...path, i]));
    if (n.op === "and") return { AND: parts };
    return parts.length ? { OR: parts } : MATCH_NONE;
  };

  const where: Prisma.ContactWhereInput = { workspaceId: ws };
  const parts = tree.rules.map((c, i) => ({ n: c, w: node(c, [i]) }));
  if (tree.op === "or" && parts.length > 1) {
    where.OR = parts.map((p) => p.w);
    return { where, issues };
  }
  const and: Prisma.ContactWhereInput[] = [];
  const rec = where as Record<string, unknown>;
  for (const { n, w } of parts) {
    const keys = Object.keys(w);
    if (!isGroup(n) && !n.missing && HOISTED_FIELDS.has(n.field) && keys.length === 1 && !(keys[0] in rec)) {
      rec[keys[0]] = (w as Record<string, unknown>)[keys[0]];
    } else {
      and.push(w);
    }
  }
  if (and.length) where.AND = and;
  return { where, issues };
}
