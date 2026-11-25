/**
 * SP-16 (ruling 16): an English one-line summary of a v2 rule tree for the
 * HJZ outbound payload (`segment.ruleSummary`). One sentence per rule,
 * joined with AND / OR, nested groups in parentheses, at most 500 chars.
 * Pure; ids are shown as ids (HJZ only displays the text).
 */
import { isGroup, type AudienceGroup, type AudienceRule, type RelTime } from "./audience-rules";

export const RULE_SUMMARY_MAX = 500;

const q = (s: string) => JSON.stringify(s);
const list = (v: string[]) => `[${v.join(", ")}]`;

function rel(v: RelTime): string {
  const unit = v.amount === 1 ? v.unit.replace(/s$/, "") : v.unit;
  return `${v.amount} ${unit}`;
}

function sentence(r: AudienceRule): string {
  switch (r.field) {
    case "tag":
      return r.op === "has" ? `has tag ${q(r.tag)}` : `does not have tag ${q(r.tag)}`;
    case "lifecycle":
      return `lifecycle is ${r.op === "in" ? "one of" : "none of"} ${list(r.values)}`;
    case "not_a_lead":
      return r.op === "is" ? "is marked not a lead" : "is not marked not a lead";
    case "last_active":
      return r.op === "within" ? `last active within the last ${rel(r.value)}` : `not active in the last ${rel(r.value)}`;
    case "conversations":
      return r.op === "any" ? "has at least one conversation" : "has no conversations";
    case "channel":
      return r.op === "is" ? `has a ${r.channel} conversation` : `has no ${r.channel} conversation`;
    case "group":
      return r.op === "in" ? `is in audience ${r.segmentId}` : `is not in audience ${r.segmentId}`;
    case "created":
      if (r.op === "within") return `created within the last ${rel((r as { value: RelTime }).value)}`;
      if (r.op === "more_than") return `created more than ${rel((r as { value: RelTime }).value)} ago`;
      return `created ${r.op} ${(r as { date: string }).date}`;
    case "pipeline_stage": {
      const where = r.stageId ? `stage ${r.stageId} of pipeline ${r.pipelineId}` : `pipeline ${r.pipelineId} (open)`;
      return r.op === "in" ? `has a card in ${where}` : `has no card in ${where}`;
    }
    case "custom_field": {
      const op = { eq: "equals", contains: "contains", gt: "is greater than", lt: "is less than", set: "is set", unset: "is not set" }[r.op];
      return `custom field ${r.defId} ${op}${r.value !== undefined && r.op !== "set" && r.op !== "unset" ? ` ${q(r.value)}` : ""}`;
    }
    case "campaign": {
      const verb = { received: "received", read: "read", replied: "replied to", not_replied: "did not reply to", failed: "failed to receive" }[r.op];
      return `${verb} campaign ${r.campaignId}`;
    }
    case "follow_up":
      return r.op === "open" ? "has an open follow-up" : r.op === "overdue" ? "has an overdue follow-up" : "has no open follow-up";
    case "industry":
    case "source":
      return `${r.field} is one of ${list(r.values)}`;
    case "name":
      return `name contains ${q(r.value)}`;
    case "phone":
      return r.op === "set" ? "has a phone number" : "has no phone number";
    case "stage_key":
      return `has a deal in stage ${list(r.keys)}`;
    default:
      return "unknown condition";
  }
}

function group(g: AudienceGroup, nested: boolean): string {
  const parts = g.rules.map((n) => (isGroup(n) ? group(n, true) : sentence(n) + (n.missing ? " (missing)" : "")));
  const text = parts.join(g.op === "and" ? " AND " : " OR ");
  return nested && parts.length > 1 ? `(${text})` : text;
}

/** The summary, or null for an empty tree (as the legacy summary of `{}`). */
export function ruleSummary(tree: AudienceGroup, max = RULE_SUMMARY_MAX): string | null {
  if (!tree.rules.length) return null;
  const text = group(tree, false);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
