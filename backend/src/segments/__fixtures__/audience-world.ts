/**
 * SP-16 spec fixtures over the in-memory evaluator (not a runtime file).
 *
 * `legacyWorld()`: about 60 contacts for the legacy-equivalence test.
 * `predicateWorld()`: a small hand-built workspace where every rule's
 * expected set is written out in the spec.
 */
import { emptyTables, type AudienceTables, type Row } from "../audience-test-db";

export const WS = "wsA";
export const WS_B = "wsB";

const LIFECYCLES = ["lead", "Lead", "customer", "churned"];
const INDUSTRIES = ["retail", "food", "tech"];
const SOURCES = ["wa", "ig", "web", "Referral"];
const NAMES = ["Sara Ali", "sara", "SARA K", "محمد", "محمد علي", "Ahmad Mixed", "Mona", "Omar سالم", "Lina", "  "];
const TAGS = [
  "[]",
  '["VIP"]',
  '["VIPER"]',
  '["Riyadh, KSA"]',
  '["VIP","Riyadh, KSA"]',
  '["Gold"]',
  '["VIPER","Gold"]',
  "not json at all",
  '["Riyadh"]',
];

export function legacyWorld(): AudienceTables {
  const t = emptyTables();
  // Two pipelines share stage keys "new" and "won".
  t.pipeline.push({ id: "P1", workspaceId: WS, archivedAt: null }, { id: "P2", workspaceId: WS, archivedAt: null });
  t.ticketStage.push(
    { id: "P1-new", pipelineId: "P1", workspaceId: WS, key: "new" },
    { id: "P1-won", pipelineId: "P1", workspaceId: WS, key: "won" },
    { id: "P2-new", pipelineId: "P2", workspaceId: WS, key: "new" },
    { id: "P2-won", pipelineId: "P2", workspaceId: WS, key: "won" },
    { id: "P2-lost", pipelineId: "P2", workspaceId: WS, key: "lost" },
  );
  const stages = ["P1-new", "P1-won", "P2-new", "P2-won", "P2-lost"];
  for (let i = 0; i < 60; i++) {
    const id = `c${String(i).padStart(3, "0")}`;
    t.contact.push(contact(id, WS, {
      lifecycle: LIFECYCLES[i % 4],
      industry: INDUSTRIES[i % 3],
      source: SOURCES[i % 4],
      name: NAMES[i % NAMES.length],
      phone: i % 3 === 0 ? null : `+96650000${String(i).padStart(4, "0")}`,
      tags: TAGS[i % TAGS.length],
    }));
    if (i % 5 !== 4) {
      t.ticket.push({
        id: `t${i}`,
        contactId: id,
        workspaceId: WS,
        stageId: stages[i % stages.length],
        pipelineId: stages[i % stages.length].slice(0, 2),
        closedAt: i % 4 === 0 ? new Date("2026-01-01T00:00:00Z") : null,
      });
    }
  }
  // Another workspace: same shapes, never selected for WS.
  for (let i = 0; i < 6; i++) {
    t.contact.push(contact(`b${i}`, WS_B, { lifecycle: "lead", tags: '["VIP"]', name: "Sara B", industry: "retail", source: "wa" }));
  }
  return t;
}

export function contact(id: string, workspaceId: string, over: Row = {}): Row {
  return {
    id,
    workspaceId,
    name: "X",
    phone: null,
    email: null,
    industry: "retail",
    lifecycle: "lead",
    source: "wa",
    tags: "[]",
    notALead: false,
    marketingOptOut: false,
    ownerId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

/** 2026-03-31 09:00 UTC = 12:00 in Riyadh (UTC+3). */
export const NOW = new Date("2026-03-31T09:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const H = 3_600_000;
const D = 24 * H;

export function predicateWorld(): AudienceTables {
  const t = emptyTables();
  t.workspace.push({ id: WS, timezone: "Asia/Riyadh" }, { id: WS_B, timezone: "UTC" });
  t.contact.push(
    contact("a1", WS, { lifecycle: "lead", createdAt: new Date("2026-03-20T10:00:00Z"), tags: '["VIP"]' }),
    // Feb 28 00:00 Riyadh exactly.
    contact("a2", WS, { lifecycle: "Customer", notALead: true, createdAt: new Date("2026-02-27T21:00:00.000Z"), tags: '["VIPER"]' }),
    // Feb 27 23:59:59.999 Riyadh.
    contact("a3", WS, { lifecycle: "churned", createdAt: new Date("2026-02-27T20:59:59.999Z") }),
    contact("a4", WS, { lifecycle: "lead", createdAt: new Date("2026-01-31T08:00:00Z") }),
    contact("a5", WS, { lifecycle: "customer", createdAt: new Date("2026-03-31T08:00:00Z") }),
    contact("b1", WS_B, { lifecycle: "lead", tags: '["VIP"]', createdAt: new Date("2026-03-20T10:00:00Z") }),
  );
  t.conversation.push(
    { id: "cv1", contactId: "a1", workspaceId: WS, channel: "whatsapp" },
    { id: "cv2", contactId: "a2", workspaceId: WS, channel: "instagram" },
    { id: "cv4", contactId: "a4", workspaceId: WS, channel: "whatsapp" },
    { id: "cv5", contactId: "a5", workspaceId: WS, channel: "telegram" },
    { id: "cvb", contactId: "b1", workspaceId: WS_B, channel: "whatsapp" },
  );
  t.message.push(
    { id: "m1", conversationId: "cv1", workspaceId: WS, from: "them", createdAt: ago(2 * D) },
    { id: "m2a", conversationId: "cv2", workspaceId: WS, from: "ai", createdAt: ago(1 * D) },
    { id: "m2b", conversationId: "cv2", workspaceId: WS, from: "human", createdAt: ago(1 * D) },
    { id: "m2c", conversationId: "cv2", workspaceId: WS, from: "them", createdAt: ago(40 * D) },
    { id: "m5", conversationId: "cv5", workspaceId: WS, from: "them", createdAt: ago(0.5 * H) },
    { id: "mb", conversationId: "cvb", workspaceId: WS_B, from: "them", createdAt: ago(1 * H) },
  );
  t.segment.push(
    seg("G", WS, "manual"),
    seg("H", WS, "hjz"),
    seg("S", WS, "crm", { rules: { v: 2, op: "and", rules: [{ field: "lifecycle", op: "in", values: ["lead"] }] } }),
    seg("GB", WS_B, "manual"),
  );
  t.segmentMember.push({ segmentId: "G", contactId: "a1" }, { segmentId: "G", contactId: "a3" }, { segmentId: "H", contactId: "a5" });
  t.customFieldDef.push(
    { id: "dT", workspaceId: WS, type: "text", archivedAt: null },
    { id: "dN", workspaceId: WS, type: "number", archivedAt: null },
    { id: "dD", workspaceId: WS, type: "date", archivedAt: null },
    { id: "dS", workspaceId: WS, type: "select", archivedAt: null },
    { id: "dB", workspaceId: WS, type: "boolean", archivedAt: null },
    { id: "dX", workspaceId: WS, type: "text", archivedAt: new Date("2026-03-01T00:00:00Z") },
    { id: "dBforeign", workspaceId: WS_B, type: "text", archivedAt: null },
  );
  t.customFieldValue.push(
    { defId: "dT", contactId: "a1", value: "Hello World" },
    { defId: "dN", contactId: "a1", value: 10 },
    { defId: "dD", contactId: "a1", value: "2026-01-15" },
    { defId: "dS", contactId: "a1", value: "Gold" },
    { defId: "dB", contactId: "a1", value: true },
    { defId: "dT", contactId: "a2", value: "hello" },
    { defId: "dN", contactId: "a2", value: 5 },
    { defId: "dD", contactId: "a2", value: "2026-03-01" },
    { defId: "dS", contactId: "a2", value: "Silver" },
    { defId: "dB", contactId: "a2", value: false },
    { defId: "dX", contactId: "a1", value: "archived" },
  );
  t.pipeline.push(
    { id: "P1", workspaceId: WS, archivedAt: null },
    { id: "P2", workspaceId: WS, archivedAt: new Date("2026-03-01T00:00:00Z") },
    { id: "P3", workspaceId: WS, archivedAt: null },
    { id: "PB", workspaceId: WS_B, archivedAt: null },
  );
  t.ticketStage.push(
    { id: "s1new", pipelineId: "P1", workspaceId: WS, key: "new" },
    { id: "s1won", pipelineId: "P1", workspaceId: WS, key: "won" },
    { id: "s2new", pipelineId: "P2", workspaceId: WS, key: "new" },
    { id: "s3new", pipelineId: "P3", workspaceId: WS, key: "new" },
    { id: "sBnew", pipelineId: "PB", workspaceId: WS_B, key: "new" },
  );
  t.ticket.push(
    { id: "k1", contactId: "a1", workspaceId: WS, pipelineId: "P1", stageId: "s1new", closedAt: null },
    { id: "k2", contactId: "a2", workspaceId: WS, pipelineId: "P1", stageId: "s1won", closedAt: ago(D) },
    { id: "k3", contactId: "a3", workspaceId: WS, pipelineId: "P2", stageId: "s2new", closedAt: null },
  );
  t.campaign.push({ id: "C1", workspaceId: WS }, { id: "CB", workspaceId: WS_B });
  t.campaignRecipient.push(
    rec("r1", "a1", { status: "sent", sentAt: ago(D) }),
    rec("r2", "a2", { status: "read", sentAt: ago(D), deliveredAt: ago(D), readAt: ago(H) }),
    rec("r3", "a3", { status: "replied", sentAt: ago(D), deliveredAt: ago(D), readAt: ago(H), repliedAt: ago(H) }),
    rec("r4", "a4", { status: "failed" }),
    rec("r0", null, { status: "replied", sentAt: ago(D), repliedAt: ago(H) }),
  );
  t.activity.push(
    { id: "act1", workspaceId: WS, contactId: "a1", doneAt: null, dueAt: new Date(NOW.getTime() + D) },
    { id: "act2", workspaceId: WS, contactId: "a2", doneAt: null, dueAt: ago(H) },
    { id: "act3", workspaceId: WS, contactId: "a3", doneAt: ago(D), dueAt: ago(2 * D) },
  );
  return t;
}

function rec(id: string, contactId: string | null, over: Row): Row {
  return { id, workspaceId: WS, campaignId: "C1", contactId, sentAt: null, deliveredAt: null, readAt: null, repliedAt: null, ...over };
}

export function seg(id: string, workspaceId: string, origin: string, over: Row = {}): Row {
  return {
    id,
    workspaceId,
    name: id,
    nameAr: null,
    color: null,
    origin,
    filter: "{}",
    rules: null,
    version: 0,
    memberCount: null,
    countedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}
