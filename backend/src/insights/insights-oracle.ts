/**
 * TEST-ONLY. A plain TypeScript implementation of every SP-11 support metric
 * definition (the plan's metric table) over the fixture world. It pins the
 * *definitions*: `insights-oracle.spec.ts` checks it against the hand-written
 * `insights-expected.ts`, and `support-metrics.db.spec.ts` checks the real SQL
 * against the same expectations. Never imported by runtime code.
 */
import type { InsightsWorld, WorldConversation, WorldMessage } from "./__fixtures__/insights-world";
import { RESOLUTION_LOOKBACK_DAYS, TOP_TOPICS, TOPIC_MIN_CONVERSATIONS } from "./insights-constants";
import {
  byNumberRows,
  FORMER_KEY,
  hoursSaved,
  peaksFrom,
  ratePct,
  teamRows,
  topicRows,
  UNATTRIBUTED_KEY,
  wholeSeconds,
  type TeamTotals,
} from "./insights-format";
import type { InsightsRange } from "./insights-range";
import { inConversationScope, type ConversationScope } from "./insights-scope";
import type { ByNumberRow, Peaks, ResolutionMix, SupportHeadline, TeamRow, TopicFrictionRow } from "./insights.dto";

export interface OracleOpts {
  range: InsightsRange;
  scope: ConversationScope;
  channelId: string | null;
}

export interface SupportData {
  headline: SupportHeadline;
  resolutionMix: ResolutionMix;
  peaks: Peaks;
  byNumber: ByNumberRow[];
  topicFriction: TopicFrictionRow[];
  team: TeamRow[];
}

type Bucket = "closed" | "escalated" | "ai" | "human";
const DAY_MS = 86_400_000;

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = (s.length - 1) / 2;
  return (s[Math.floor(mid)] + s[Math.ceil(mid)]) / 2; // percentile_cont(0.5)
}

const before = (a: WorldMessage, b: WorldMessage) =>
  a.createdAt.getTime() < b.createdAt.getTime() || (a.createdAt.getTime() === b.createdAt.getTime() && a.id < b.id);

function localDowHour(d: Date, tz: string): { dow: number; hour: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", hourCycle: "h23" }).formatToParts(d);
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
  return { dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd), hour: Number(parts.find((p) => p.type === "hour")?.value) };
}

export function supportOracle(world: InsightsWorld, opts: OracleOpts): SupportData {
  const { range, scope, channelId } = opts;
  const F = range.fromUtc.getTime();
  const T = range.toUtcExclusive.getTime();
  const inRange = (d: Date | null | undefined) => !!d && d.getTime() >= F && d.getTime() < T;

  // S and ch: the conversations this viewer (and channel filter) may count.
  const convs = world.conversations.filter(
    (c) => inConversationScope(scope, c.assigneeId) && (channelId === null || c.channelId === channelId),
  );
  const thread = new Map<string, WorldMessage[]>();
  for (const c of convs) thread.set(c.id, []);
  for (const m of world.messages) thread.get(m.conversationId)?.push(m);
  for (const list of thread.values()) list.sort((a, b) => (before(a, b) ? -1 : before(b, a) ? 1 : 0));

  const after = (list: WorldMessage[], m: WorldMessage) => list.filter((x) => before(m, x));
  const isExchangeStart = (list: WorldMessage[], m: WorldMessage) => {
    if (m.from !== "them") return false;
    const prev = list.filter((x) => before(x, m)).pop();
    return !prev || prev.from !== "them";
  };
  const members = new Set(world.users.filter((u) => u.role !== null).map((u) => u.id));
  const senderKey = (id: string | null | undefined) => (id == null ? UNATTRIBUTED_KEY : members.has(id) ? id : FORMER_KEY);
  const channel = new Map(world.channels.map((c) => [c.id, c]));
  const isWhatsApp = (c: WorldConversation) => {
    const kind = c.channelId ? channel.get(c.channelId)?.kind : undefined;
    return (kind ?? c.channel).toLowerCase() === "whatsapp";
  };

  // conversations: distinct conversations with a customer message in range.
  const rangeConvs = convs.filter((c) => (thread.get(c.id) ?? []).some((m) => m.from === "them" && inRange(m.createdAt)));

  // decided + the disjoint bucket (closed → escalated → ai → human).
  const lookbackMs = RESOLUTION_LOOKBACK_DAYS * DAY_MS;
  const bucketOf = (c: WorldConversation): Bucket => {
    if (c.resolutionStatus === "closed") return "closed";
    if (c.escalated || c.resolutionIssue === "complaint" || c.resolutionIssue === "escalation") return "escalated";
    const r = (c.resolvedAt as Date).getTime();
    const staff = (thread.get(c.id) ?? []).some(
      (m) => m.from === "human" && m.createdAt.getTime() > r - lookbackMs && m.createdAt.getTime() <= r,
    );
    return staff ? "human" : "ai";
  };
  const decided = convs
    .filter((c) => (c.resolutionStatus === "resolved" || c.resolutionStatus === "closed") && inRange(c.resolvedAt))
    .map((c) => ({ c, bucket: bucketOf(c) }));
  const aiResolved = decided.filter((d) => d.bucket === "ai").length;

  // Exchanges starting in range: reply r, next exchange start, first staff reply h.
  const exchanges: { start: WorldMessage; reply: WorldMessage | null; human: WorldMessage | null }[] = [];
  for (const c of convs) {
    const list = thread.get(c.id) ?? [];
    for (const e of list) {
      if (!inRange(e.createdAt) || !isExchangeStart(list, e)) continue;
      const rest = after(list, e);
      const reply = rest.find((x) => x.from !== "them") ?? null;
      const next = reply ? (after(list, reply).find((x) => x.from === "them") ?? null) : null;
      const human = rest.find((x) => x.from === "human" && (!next || before(x, next))) ?? null;
      exchanges.push({ start: e, reply, human });
    }
  }
  const samples = exchanges.filter((x) => x.human).map((x) => ({ x, sec: (x.human!.createdAt.getTime() - x.start.createdAt.getTime()) / 1000 }));

  // Handling: resolvedAt − the earliest exchange start in the lookback window.
  const handling: number[] = [];
  for (const { c } of decided) {
    const r = (c.resolvedAt as Date).getTime();
    const list = thread.get(c.id) ?? [];
    const start = list.find(
      (m) => m.createdAt.getTime() > r - lookbackMs && m.createdAt.getTime() <= r && isExchangeStart(list, m),
    );
    if (start) handling.push((r - start.createdAt.getTime()) / 1000);
  }

  // Time saved: customer messages in range whose next non-customer message is the AI's.
  let customerMessages = 0;
  for (const c of convs) {
    const list = thread.get(c.id) ?? [];
    for (const m of list) {
      if (m.from !== "them" || !inRange(m.createdAt)) continue;
      if (after(list, m).find((x) => x.from !== "them")?.from === "ai") customerMessages += 1;
    }
  }

  // Ticket share: range conversations with a support ticket created in range.
  const support = new Set(world.pipelines.filter((p) => p.kind === "support").map((p) => p.id));
  const ticketed = rangeConvs.filter((c) =>
    world.tickets.some((t) => t.conversationId === c.id && support.has(t.pipelineId) && inRange(t.createdAt)),
  ).length;

  const headline: SupportHeadline = {
    conversations: rangeConvs.length,
    decided: decided.length,
    aiResolved,
    aiResolutionRate: ratePct(aiResolved, decided.length),
    medianFirstResponseSec: wholeSeconds(median(samples.map((s) => s.sec))),
    unanswered: exchanges.filter((x) => !x.reply).length,
    medianHandlingSec: wholeSeconds(median(handling)),
    timeSaved: { customerMessages, hours: hoursSaved(customerMessages) },
    ticketShare: ratePct(ticketed, rangeConvs.length),
  };

  const resolutionMix: ResolutionMix = { ai: 0, human: 0, escalated: 0, closed: 0 };
  for (const d of decided) resolutionMix[d.bucket] += 1;

  // Peaks: customer messages in range by local day of week and hour.
  const peakRows: { dow: number; hour: number; n: number }[] = [];
  for (const c of convs) {
    for (const m of thread.get(c.id) ?? []) {
      if (m.from === "them" && inRange(m.createdAt)) peakRows.push({ ...localDowHour(m.createdAt, range.tz), n: 1 });
    }
  }

  // By number (WhatsApp only).
  const numbers = new Map<string | null, { conversations: number; decided: number; ai: number }>();
  const slot = (id: string | null) => {
    if (!numbers.has(id)) numbers.set(id, { conversations: 0, decided: 0, ai: 0 });
    return numbers.get(id)!;
  };
  for (const c of rangeConvs) if (isWhatsApp(c)) slot(c.channelId).conversations += 1;
  for (const d of decided) {
    if (!isWhatsApp(d.c)) continue;
    const s = slot(d.c.channelId);
    s.decided += 1;
    if (d.bucket === "ai") s.ai += 1;
  }
  const byNumber = byNumberRows(
    [...numbers.entries()].map(([id, s]) => ({
      channelId: id,
      label: id ? (channel.get(id)?.displayName ?? null) : null,
      exists: !!id && channel.has(id),
      ...s,
    })),
  );

  // Topic friction over decided conversations (each topic once per conversation).
  const topics = new Map<string, { count: number; escalated: number; negative: number }>();
  for (const d of decided) {
    const list = Array.isArray(d.c.topics) ? (d.c.topics as unknown[]) : [];
    const seen = new Set(list.map((t) => String(t).replace(/^ +| +$/g, "").toLowerCase()).filter((t) => t !== ""));
    for (const t of seen) {
      const s = topics.get(t) ?? { count: 0, escalated: 0, negative: 0 };
      s.count += 1;
      if (d.bucket === "escalated") s.escalated += 1;
      if (d.c.resolutionSentiment === "negative") s.negative += 1;
      topics.set(t, s);
    }
  }
  const topicFriction = topicRows(
    [...topics.entries()].filter(([, s]) => s.count >= TOPIC_MIN_CONVERSATIONS).map(([topic, s]) => ({ topic, ...s })),
  ).slice(0, TOP_TOPICS);

  // Team.
  const totals = new Map<string, TeamTotals & { samples: number[] }>();
  const t = (key: string) => {
    if (!totals.has(key)) totals.set(key, { assigned: 0, replies: 0, resolved: 0, median: null, samples: [] });
    return totals.get(key)!;
  };
  for (const c of rangeConvs) if (c.assigneeId) t(senderKey(c.assigneeId)).assigned += 1;
  for (const c of convs) {
    for (const m of thread.get(c.id) ?? []) if (m.from === "human" && inRange(m.createdAt)) t(senderKey(m.sentById)).replies += 1;
  }
  for (const s of samples) t(senderKey(s.x.human!.sentById)).samples.push(s.sec);
  for (const d of decided) if (d.bucket === "human" && d.c.assigneeId) t(senderKey(d.c.assigneeId)).resolved += 1;
  for (const v of totals.values()) v.median = median(v.samples);
  const team = teamRows(
    world.users.filter((u) => u.role !== null).map((u) => ({ userId: u.id, name: u.name })),
    totals,
  );

  return { headline, resolutionMix, peaks: peaksFrom(peakRows), byNumber, topicFriction, team };
}
