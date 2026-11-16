/**
 * In-memory Prisma double for the SP-19 channel specs (not a runtime file;
 * same convention as src/pipelines/test-prisma.ts).
 *
 * Supports the subset of Prisma the channel code uses: equality, `in`,
 * `notIn`, `not`, `null`, AND/OR/NOT, the `channel: { is: null }` relation
 * filter on Integration, single-key orderBy, compound uniques used by
 * upserts, and the Channel unique constraints (including the SQL-only
 * "one default per kind" partial index), which throw P2002 like Postgres.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { slaDueAtFor } from "../tickets/ticket-sla";

type Row = Record<string, any>;
export type Tables = Record<string, Row[]>;

let seq = 0;
const nextId = (p: string) => `${p}_${++seq}`;

function matchValue(v: any, cond: any): boolean {
  if (cond === null) return v === null || v === undefined;
  if (cond instanceof Date) return v instanceof Date && v.getTime() === cond.getTime();
  if (typeof cond === "object" && !Array.isArray(cond)) {
    // SP-14 (review m3): a Json column filtered by `{ path: [...], equals }`.
    if ("path" in cond) {
      let cur = v;
      for (const k of cond.path as string[]) cur = cur && typeof cur === "object" ? cur[k] : undefined;
      return "equals" in cond ? cur === cond.equals : cur !== undefined;
    }
    if ("in" in cond && !(cond.in as any[]).includes(v)) return false;
    if ("notIn" in cond && (cond.notIn as any[]).includes(v)) return false;
    if ("not" in cond) {
      if (cond.not === null ? v === null || v === undefined : matchValue(v, cond.not)) return false;
    }
    if ("equals" in cond) {
      // SP-17: `mode: "insensitive"` on a string equals.
      const eq =
        cond.mode === "insensitive" && typeof v === "string" && typeof cond.equals === "string"
          ? v.toLowerCase() === cond.equals.toLowerCase()
          : v === cond.equals;
      if (!eq) return false;
    }
    // SP-13: Postgres array columns (String[]).
    if ("has" in cond && !(Array.isArray(v) && v.includes(cond.has))) return false;
    if ("hasSome" in cond && !(Array.isArray(v) && (cond.hasSome as any[]).some((x) => v.includes(x)))) return false;
    if ("isEmpty" in cond && (Array.isArray(v) && v.length === 0) !== cond.isEmpty) return false;
    // SP-17: `mode: "insensitive"` (Postgres ILIKE) lowercases both sides.
    if ("contains" in cond) {
      const fold = (x: string) => (cond.mode === "insensitive" ? x.toLowerCase() : x);
      if (!fold(String(v ?? "")).includes(fold(String(cond.contains)))) return false;
    }
    if ("gt" in cond && !(v != null && v > cond.gt)) return false;
    if ("lt" in cond && !(v != null && v < cond.lt)) return false;
    if ("gte" in cond && !(v != null && v >= cond.gte)) return false;
    if ("lte" in cond && !(v != null && v <= cond.lte)) return false;
    return true;
  }
  return v === cond;
}

export function matches(row: Row, where: any, db: Tables, model: string): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (k === "AND") {
      const list = Array.isArray(cond) ? cond : [cond];
      if (!list.every((w) => matches(row, w, db, model))) return false;
      continue;
    }
    if (k === "OR") {
      if (!(cond as any[]).some((w) => matches(row, w, db, model))) return false;
      continue;
    }
    if (k === "NOT") {
      const list = Array.isArray(cond) ? cond : [cond];
      if (list.some((w) => matches(row, w, db, model))) return false;
      continue;
    }
    if (model === "contact" && k === "segmentMembers") {
      // SP-13 audience stream: `segmentMembers: { some: { segmentId } }`.
      const some = (cond as any)?.some ?? {};
      const hit = (db.segmentMember ?? []).some((m) => m.contactId === row.id && matches(m, some, db, "segmentMember"));
      if (!hit) return false;
      continue;
    }
    // SP-09: to-one relation filters on tickets, attachments and messages
    // (`stage: { isTerminal: false }`, `conversation: <scope>`).
    if (RELATION_FILTERS[model]?.includes(k)) {
      const inner = (cond as any)?.is ?? cond;
      const rel = relation(model, row, k, db) as Row | null | undefined;
      if (inner === null) {
        if (rel) return false;
        continue;
      }
      if (!rel || !matches(rel, inner, db, RELATIONS[model][k][0])) return false;
      continue;
    }
    // SP-15: AdReferral -> Conversation relation filter (`{ is: {...} }` or a plain where).
    if (model === "adReferral" && k === "conversation") {
      const inner = (cond as any)?.is ?? cond;
      const conv = (db.conversation ?? []).find((c) => c.id === row.conversationId);
      if (!conv || !matches(conv, inner, db, "conversation")) return false;
      continue;
    }
    if (model === "integration" && k === "channel") {
      const linked = (db.channel ?? []).some((c) => c.integrationId === row.id);
      const wantNull = cond === null || (cond as any)?.is === null;
      if (wantNull ? linked : !linked) return false;
      continue;
    }
    if (
      k.includes("_") &&
      cond &&
      typeof cond === "object" &&
      !Array.isArray(cond) &&
      Object.keys(cond).every((ck) => k.split("_").includes(ck))
    ) {
      // compound unique, e.g. workspaceId_externalSource_externalId
      // SP-15: Date parts (AdSpendDaily adSourceId_date) compare by instant.
      if (!Object.entries(cond).every(([ck, cv]) => keyPart(row[ck]) === keyPart(cv))) return false;
      continue;
    }
    if (!matchValue(row[k], cond)) return false;
  }
  return true;
}

function sortRows(rows: Row[], orderBy: any): Row[] {
  if (!orderBy) return rows;
  const list = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((a, b) => {
    for (const o of list) {
      const [k, spec] = Object.entries(o)[0] as [string, string | { sort: string; nulls?: "first" | "last" }];
      // SP-14: the `{ sort, nulls }` form places nulls explicitly. The plain
      // string form keeps this double's historical null handling.
      const dir = typeof spec === "string" ? spec : spec.sort;
      const av = a[k] instanceof Date ? a[k].getTime() : a[k];
      const bv = b[k] instanceof Date ? b[k].getTime() : b[k];
      if (typeof spec === "object") {
        const nulls = spec.nulls ?? (dir === "desc" ? "first" : "last");
        if (av == null && bv == null) continue;
        if (av == null || bv == null) return (av == null) === (nulls === "first") ? -1 : 1;
      }
      if (av === bv) continue;
      const cmp = av > bv ? 1 : -1;
      return dir === "desc" ? -cmp : cmp;
    }
    return 0;
  });
}

function p2002(target: string): Error {
  const e = new Error(`Unique constraint failed on ${target}`) as Error & { code: string };
  e.code = "P2002";
  return e;
}

function checkChannelUniques(rows: Row[], row: Row) {
  for (const o of rows) {
    if (o === row) continue;
    if (o.id === row.id) throw p2002("Channel_pkey");
    if (row.integrationId && o.integrationId === row.integrationId) throw p2002("Channel_integrationId_key");
    if (
      row.externalId != null &&
      o.workspaceId === row.workspaceId &&
      o.provider === row.provider &&
      o.externalId === row.externalId
    )
      throw p2002("Channel_workspaceId_provider_externalId_key");
    if (row.isDefault && o.isDefault && o.workspaceId === row.workspaceId && o.kind === row.kind)
      throw p2002("Channel_one_default_per_kind");
  }
}

const DEFAULTS: Record<string, () => Row> = {
  channel: () => ({
    status: "active",
    isDefault: false,
    externalId: null,
    phoneNumber: null,
    statusReason: null,
    config: null,
    secretsEnc: null,
    webhookSecretHash: null,
    integrationId: null,
    lastInboundAt: null,
    disconnectedAt: null,
    health: null,
    // SP-14
    healthCheckedAt: null,
    healthAttemptedAt: null,
  }),
  integration: () => ({ provider: "meta", pageId: null, pageName: null, accessToken: null, raw: null }),
  conversation: () => ({
    channelId: null,
    externalId: null,
    aiEnabled: false,
    aiPausedAt: null,
    unread: 0,
    // SP-15
    adSourceId: null,
    adReferredAt: null,
  }),
  // SP-15
  adSource: () => ({
    headline: null,
    body: null,
    mediaType: null,
    mediaUrl: null,
    mediaId: null,
    sourceUrl: null,
    welcomeText: null,
    adAccountId: null,
    adName: null,
    adSetName: null,
    campaignName: null,
    namesFrom: null,
    firstReferredAt: null,
    lastReferredAt: null,
  }),
  adReferral: () => ({ channelId: null, ctwaClid: null, firstTouch: false }),
  metaAdsConnection: () => ({
    status: "pending",
    statusReason: null,
    tokenEnc: null,
    tokenExpiresAt: null,
    pendingTokenEnc: null,
    pendingExpiresAt: null,
    scopes: null,
    adAccountId: null,
    adAccountName: null,
    currency: null,
    timezone: null,
    pageId: null,
    pageName: null,
    connectedById: null,
    connectedAt: null,
    lastSyncedAt: null,
    lastSyncError: null,
    syncAttemptedAt: null,
    spendBackfilledAt: null,
    checkAttemptedAt: null,
    leadCheckpoints: null,
  }),
  metaLead: () => ({ formName: null, adId: null, adSourceId: null, contactId: null }),
  // SP-12
  campaign: () => ({
    recipientTracking: false,
    recipientsSyncedAt: null,
    recipientSyncSkip: 0,
    scheduledAt: null,
    launchedAt: null,
    // SP-13
    senderChannelIds: [],
    varMap: null,
    headerMediaId: null,
    launchStage: null,
    launchHeartbeatAt: null,
    launchAttempts: 0,
    launchedById: null,
    planCompletedAt: null,
    cancelRequestedAt: null,
    sendTransport: null,
  }),
  campaignRecipient: () => ({
    contactId: null,
    channelId: null,
    phone: null,
    contactName: null,
    status: "queued",
    messageId: null,
    sentAt: null,
    deliveredAt: null,
    readAt: null,
    repliedAt: null,
    replyText: null,
    buttonPayload: null,
    replyMessageId: null,
    failureCode: null,
    failureReason: null,
    // SP-13
    broadcastId: null,
    templateParams: null,
    sendAttemptedAt: null,
  }),
  // SP-13
  campaignBroadcast: () => ({
    channelId: null,
    stage: "pending",
    recipientCount: 0,
    importedThroughId: null,
    addedThroughId: null,
    createAttemptedAt: null,
    zernioBroadcastId: null,
    recipientSyncSkip: 0,
    recipientsSyncedAt: null,
    lastError: null,
  }),
  template: () => ({ headerMediaId: null }),
  // SP-17: media details (only rows created through the double get these).
  media: () => ({
    uploadedById: null,
    publicToken: null,
    publicTokenExpiresAt: null,
    title: null,
    alt: null,
    tags: [],
    useWhen: null,
    approvedForAgent: false,
  }),
  customFieldDef: () => ({ entity: "contact", options: null, order: 0, archivedAt: null }),
  // SP-09: tickets (the DB defaults; slaDueAt comes from the trigger mirror below).
  ticket: () => ({
    conversationId: null,
    ownerId: null,
    description: null,
    value: null,
    currency: "SAR",
    lostReason: null,
    lostReasonId: null,
    closedAt: null,
    enteredStageAt: new Date(),
    priority: "normal",
    category: null,
    slaDueAt: null,
  }),
  ticketAttachment: () => ({ messageId: null, addedById: null }),
  ticketActivity: () => ({ fromStage: null, toStage: null, note: null, byUserId: null }),
  // SP-10: the bookings catalog (the DB defaults) and the Appointment columns.
  service: () => ({
    color: "info",
    price: null,
    currency: "SAR",
    active: true,
    archivedAt: null,
    order: 0,
    version: 0,
  }),
  staffResource: () => ({
    userId: null,
    nameAr: null,
    role: null,
    color: "accent",
    schedule: {},
    active: true,
    archivedAt: null,
    version: 0,
  }),
  catalogImport: () => ({
    createdById: null,
    status: "extracting",
    inputText: null,
    sourceUrl: null,
    fileMediaId: null,
    fileName: null,
    extractedBy: null,
    proposal: null,
    total: 0,
    processed: 0,
    created: 0,
    skipped: 0,
    failed: 0,
    errors: [],
    errorKey: null,
    heartbeatAt: null,
    startedAt: null,
    finishedAt: null,
  }),
  appointment: () => ({
    serviceId: null,
    resourceId: null,
    version: 0,
  }),
};

/** SP-15 unique constraints, as Postgres enforces them (P2002). */
const SP15_UNIQUES: Record<string, Array<[string, string[]]>> = {
  adSource: [["AdSource_workspaceId_sourceType_sourceId_key", ["workspaceId", "sourceType", "sourceId"]]],
  adReferral: [["AdReferral_messageId_key", ["messageId"]]],
  adSpendDaily: [["AdSpendDaily_adSourceId_date_key", ["adSourceId", "date"]]],
  metaAdsConnection: [["MetaAdsConnection_workspaceId_key", ["workspaceId"]]],
  metaLead: [["MetaLead_workspaceId_leadgenId_key", ["workspaceId", "leadgenId"]]],
  // SP-09
  ticketAttachment: [["TicketAttachment_ticketId_mediaId_key", ["ticketId", "mediaId"]]],
  // SP-10
  staffService: [["StaffService_pkey", ["resourceId", "serviceId"]]],
};
/** SP-10: unique indexes over a nullable column (NULLs are distinct, as in Postgres). */
const NULLABLE_UNIQUES: Record<string, Array<[string, string[]]>> = {
  staffResource: [["StaffResource_workspaceId_userId_key", ["workspaceId", "userId"]]],
};
const keyPart = (v: any) => (v instanceof Date ? v.getTime() : v);
function sp15Clash(model: string, rows: Row[], row: Row): string | null {
  for (const [name, cols] of SP15_UNIQUES[model] ?? []) {
    if (rows.some((o) => o !== row && cols.every((c) => keyPart(o[c]) === keyPart(row[c])))) return name;
  }
  for (const [name, cols] of NULLABLE_UNIQUES[model] ?? []) {
    if (cols.some((c) => row[c] == null)) continue;
    if (rows.some((o) => o !== row && cols.every((c) => keyPart(o[c]) === keyPart(row[c])))) return name;
  }
  return null;
}

/** SP-15: the relations specs read through `include` / nested `select`. */
const RELATIONS: Record<string, Record<string, [string, string, "one" | "many"]>> = {
  conversation: {
    adSource: ["adSource", "adSourceId", "one"],
    adReferrals: ["adReferral", "conversationId", "many"],
    // SP-09: the derived ticket channel.
    channelRef: ["channel", "channelId", "one"],
  },
  adReferral: {
    conversation: ["conversation", "conversationId", "one"],
    adSource: ["adSource", "adSourceId", "one"],
    message: ["message", "messageId", "one"],
  },
  adSource: { media: ["media", "mediaId", "one"], referrals: ["adReferral", "adSourceId", "many"] },
  metaLead: { adSource: ["adSource", "adSourceId", "one"], contact: ["contact", "contactId", "one"] },
  // SP-09
  ticket: {
    stage: ["ticketStage", "stageId", "one"],
    contact: ["contact", "contactId", "one"],
    pipeline: ["pipeline", "pipelineId", "one"],
    activities: ["ticketActivity", "ticketId", "many"],
    attachments: ["ticketAttachment", "ticketId", "many"],
  },
  pipeline: { stages: ["ticketStage", "pipelineId", "many"] },
  ticketAttachment: {
    ticket: ["ticket", "ticketId", "one"],
    media: ["media", "mediaId", "one"],
    addedBy: ["user", "addedById", "one"],
  },
  message: { conversation: ["conversation", "conversationId", "one"] },
};
/** SP-09: to-one relations `matches` follows as filters. */
const RELATION_FILTERS: Record<string, string[]> = {
  ticket: ["stage", "pipeline", "contact"],
  ticketAttachment: ["ticket", "media"],
  message: ["conversation"],
};

/**
 * SP-09: mirror of the "ticket_sla_due_at" trigger (BEFORE INSERT OR UPDATE OF
 * "stageId"): on insert, or when stageId changes, slaDueAt = entry +
 * slaMinutes of the new stage (null for none/terminal). The entry time is the
 * writer's own enteredStageAt when it set one in this statement, else now.
 */
function ticketSlaHook(db: Tables, prev: Row | null, next: Row, data: Row) {
  if (prev && (!("stageId" in data) || next.stageId === prev.stageId)) return;
  const stage = (db.ticketStage ?? []).find((s) => s.id === next.stageId);
  const setEntered =
    !prev || ("enteredStageAt" in data && keyPart(next.enteredStageAt) !== keyPart(prev.enteredStageAt));
  const entered = setEntered && next.enteredStageAt instanceof Date ? next.enteredStageAt : new Date();
  next.slaDueAt = slaDueAtFor(stage, entered);
}
function relation(model: string, row: Row, key: string, db: Tables): Row | Row[] | null | undefined {
  const rel = RELATIONS[model]?.[key];
  if (!rel) return undefined;
  const [target, fk, kind] = rel;
  if (kind === "one") return (db[target] ?? []).find((r) => r.id === row[fk]) ?? null;
  return (db[target] ?? []).filter((r) => r[fk] === row.id);
}

/** SP-10: an update that would break a nullable unique index throws P2002. */
function nullableUniqueCheck(model: string, rows: Row[], row: Row, next: Row) {
  if (!NULLABLE_UNIQUES[model]) return;
  const clash = sp15Clash(model, rows.filter((x) => x !== row), next);
  if (clash) throw p2002(clash);
}

/** SP-13: @@unique([campaignId, partitionKey]). */
function broadcastClash(rows: Row[], row: Row): boolean {
  return rows.some((o) => o !== row && o.campaignId === row.campaignId && o.partitionKey === row.partitionKey);
}

/** SP-12: @@unique([campaignId, phone]) (NULL phones are distinct, as in Postgres). */
function recipientClash(rows: Row[], row: Row): boolean {
  return row.phone != null && rows.some((o) => o !== row && o.campaignId === row.campaignId && o.phone === row.phone);
}

function project(row: Row, select?: any, include?: any, db?: Tables, model?: string): Row {
  let out: Row = { ...row };
  const nested = (k: string, v: any): any => {
    const r = model && db ? relation(model, row, k, db) : undefined;
    if (r === undefined) return undefined;
    const target = RELATIONS[model as string][k][0];
    const sel = typeof v === "object" ? v.select : undefined;
    const inc = typeof v === "object" ? v.include : undefined;
    if (Array.isArray(r)) return r.map((x) => project(x, sel, inc, db, target));
    return r ? project(r, sel, inc, db, target) : null;
  };
  if (include && db) {
    for (const [k, v] of Object.entries(include)) {
      if (!v) continue;
      const rel = nested(k, v);
      if (rel !== undefined) {
        out[k] = rel;
        continue;
      }
      if (k === "contact") out.contact = (db.contact ?? []).find((c) => c.id === row.contactId) ?? null;
      if (k === "labels") out.labels = [];
      if (k === "messages") out.messages = (db.message ?? []).filter((m) => m.conversationId === row.id);
      // SP-14: WorkspaceMember.roleRef (PermissionService.membersWith).
      if (k === "roleRef") out.roleRef = (db.role ?? []).find((r) => r.id === row.roleId) ?? null;
    }
  }
  if (select) {
    const picked: Row = {};
    for (const [k, v] of Object.entries(select)) {
      if (!v) continue;
      const rel = typeof v === "object" ? nested(k, v) : undefined;
      picked[k] = rel !== undefined ? rel : out[k];
    }
    out = picked;
  }
  return out;
}

export function makeFakePrisma(seed: Partial<Tables> = {}) {
  const db: Tables = {
    channel: [],
    integration: [],
    conversation: [],
    contact: [],
    message: [],
    workspace: [],
    campaign: [],
    template: [],
    campaignRecipient: [],
    // SP-15
    adSource: [],
    adReferral: [],
    adSpendDaily: [],
    metaAdsConnection: [],
    metaLead: [],
    ...seed,
  } as Tables;

  const model = (name: string) => {
    const rows = () => (db[name] ??= []);
    const write = (row: Row) => {
      if (name === "channel") checkChannelUniques(rows(), row);
      if (name === "campaignBroadcast" && broadcastClash(rows(), row)) throw p2002("CampaignBroadcast_campaignId_partitionKey_key");
      const sp15 = sp15Clash(name, rows(), row);
      if (sp15) throw p2002(sp15);
    };
    // Like Prisma, every call returns a LAZY thenable: nothing runs until it
    // is awaited, so an array $transaction can snapshot first and roll back.
    const op = (fn: (a: any) => any) => jest.fn((a: any = {}) => lazy(() => fn(a)));
    return {
      findMany: op((a) => {
        let r = rows().filter((x) => matches(x, a.where, db, name));
        r = sortRows(r, a.orderBy);
        if (a.take) r = r.slice(0, a.take);
        return r.map((x) => project(x, a.select, a.include, db, name));
      }),
      findFirst: op((a) => {
        const r = sortRows(rows().filter((x) => matches(x, a.where, db, name)), a.orderBy)[0];
        return r ? project(r, a.select, a.include, db, name) : null;
      }),
      findUnique: op((a) => {
        const r = rows().find((x) => matches(x, a.where, db, name));
        return r ? project(r, a.select, a.include, db, name) : null;
      }),
      count: op((a) => rows().filter((x) => matches(x, a.where, db, name)).length),
      // Supports `by: [field]` with `_count: { _all: true }` (what SP-12 uses).
      groupBy: op((a) => {
        const hit = rows().filter((x) => matches(x, a.where, db, name));
        const by: string[] = a.by ?? [];
        const groups = new Map<string, Row>();
        for (const x of hit) {
          const key = JSON.stringify(by.map((k) => x[k]));
          const g = groups.get(key) ?? Object.fromEntries([...by.map((k) => [k, x[k]]), ["_count", { _all: 0 }]]);
          g._count._all++;
          // SP-15: `_max` (the inbox WhatsApp window query).
          for (const f of Object.keys(a._max ?? {})) {
            g._max ??= {};
            const cur = g._max[f];
            if (x[f] != null && (cur == null || x[f] > cur)) g._max[f] = x[f];
            else g._max[f] ??= null;
          }
          groups.set(key, g);
        }
        return [...groups.values()];
      }),
      createMany: op((a) => {
        let count = 0;
        for (const d of a.data as Row[]) {
          const row: Row = {
            id: d.id ?? nextId(name),
            ...(DEFAULTS[name]?.() ?? {}),
            createdAt: new Date(),
            updatedAt: new Date(),
            ...d,
          };
          if (name === "campaignRecipient" && recipientClash(rows(), row)) {
            if (a.skipDuplicates) continue;
            throw p2002("CampaignRecipient_campaignId_phone_key");
          }
          // SP-12 T2: SegmentMember @@id([segmentId, contactId]).
          if (name === "segmentMember" && rows().some((o) => o.segmentId === row.segmentId && o.contactId === row.contactId)) {
            if (a.skipDuplicates) continue;
            throw p2002("SegmentMember_pkey");
          }
          if (a.skipDuplicates && sp15Clash(name, rows(), row)) continue;
          write(row);
          rows().push(row);
          count++;
        }
        return { count };
      }),
      create: op((a) => {
        const row: Row = {
          id: a.data.id ?? nextId(name),
          ...(DEFAULTS[name]?.() ?? {}),
          createdAt: new Date(),
          updatedAt: new Date(),
          ...a.data,
        };
        if (name === "ticket") ticketSlaHook(db, null, row, a.data);
        write(row);
        rows().push(row);
        return project(row, a.select, a.include, db, name);
      }),
      update: op((a) => {
        const row = rows().find((x) => matches(x, a.where, db, name));
        if (!row) throw p2025();
        const next = { ...row, ...applyData(row, a.data), updatedAt: new Date() };
        if (name === "channel") checkChannelUniques(rows().filter((x) => x !== row), next);
        if (name === "ticket") ticketSlaHook(db, row, next, a.data);
        nullableUniqueCheck(name, rows(), row, next);
        Object.assign(row, next);
        return project(row, a.select, a.include, db, name);
      }),
      updateMany: op((a) => {
        const hit = rows().filter((x) => matches(x, a.where, db, name));
        for (const row of hit) {
          const next = { ...row, ...applyData(row, a.data), updatedAt: new Date() };
          if (name === "channel") checkChannelUniques(rows().filter((x) => x !== row), next);
          if (name === "ticket") ticketSlaHook(db, row, next, a.data);
          nullableUniqueCheck(name, rows(), row, next);
          Object.assign(row, next);
        }
        return { count: hit.length };
      }),
      upsert: op((a) => {
        const row = rows().find((x) => matches(x, a.where, db, name));
        if (row) {
          Object.assign(row, applyData(row, a.update), { updatedAt: new Date() });
          return project(row);
        }
        const created: Row = {
          id: nextId(name),
          ...(DEFAULTS[name]?.() ?? {}),
          createdAt: new Date(),
          updatedAt: new Date(),
          ...a.create,
        };
        write(created);
        rows().push(created);
        return project(created);
      }),
      delete: op((a) => {
        const i = rows().findIndex((x) => matches(x, a.where, db, name));
        if (i < 0) throw p2025();
        const [row] = rows().splice(i, 1);
        onDeleted(row);
        return row;
      }),
      deleteMany: op((a) => {
        const hit = rows().filter((x) => matches(x, a.where, db, name));
        db[name] = rows().filter((x) => !hit.includes(x));
        hit.forEach(onDeleted);
        return { count: hit.length };
      }),
    };
  };

  /** FK actions Postgres applies on delete. */
  function onDeleted(row: Row) {
    // Channel.integrationId → Integration ON DELETE SET NULL
    for (const c of db.channel ?? []) if (c.integrationId === row.id) c.integrationId = null;
    // SP-12: CampaignRecipient.contactId / channelId → SET NULL, campaignId → CASCADE.
    // (Ids are unique across tables in these specs, so matching by id is enough.)
    for (const r of db.campaignRecipient ?? []) {
      if (r.contactId === row.id) r.contactId = null;
      if (r.channelId === row.id) r.channelId = null;
    }
    if (db.campaignRecipient) db.campaignRecipient = db.campaignRecipient.filter((r) => r.campaignId !== row.id);
    // SP-13: CampaignRecipient.broadcastId and CampaignBroadcast.channelId → SET NULL,
    // CampaignBroadcast.campaignId → CASCADE, Campaign/Template.headerMediaId → SET NULL.
    for (const r of db.campaignRecipient ?? []) if (r.broadcastId === row.id) r.broadcastId = null;
    for (const b of db.campaignBroadcast ?? []) if (b.channelId === row.id) b.channelId = null;
    if (db.campaignBroadcast) db.campaignBroadcast = db.campaignBroadcast.filter((b) => b.campaignId !== row.id);
    for (const c of db.campaign ?? []) if (c.headerMediaId === row.id) c.headerMediaId = null;
    for (const t of db.template ?? []) if (t.headerMediaId === row.id) t.headerMediaId = null;
    // SP-15: Conversation/AdSource/Message deletes cascade into AdReferral; Conversation.adSourceId,
    // AdSource.mediaId and MetaLead.adSourceId -> SET NULL; a Contact delete cascades MetaLead.
    if (db.adReferral) db.adReferral = db.adReferral.filter((r) => r.conversationId !== row.id && r.adSourceId !== row.id && r.messageId !== row.id);
    for (const c of db.conversation ?? []) if (c.adSourceId === row.id) c.adSourceId = null;
    for (const s of db.adSource ?? []) if (s.mediaId === row.id) s.mediaId = null;
    for (const l of db.metaLead ?? []) if (l.adSourceId === row.id) l.adSourceId = null;
    if (db.metaLead) db.metaLead = db.metaLead.filter((l) => l.contactId !== row.id);
    // SP-09: TicketAttachment.ticketId / mediaId / workspaceId -> CASCADE, addedById -> SET NULL.
    if (db.ticketAttachment) {
      db.ticketAttachment = db.ticketAttachment.filter(
        (a) => a.ticketId !== row.id && a.mediaId !== row.id && a.workspaceId !== row.id,
      );
      for (const a of db.ticketAttachment) if (a.addedById === row.id) a.addedById = null;
    }
    // SP-10: StaffService.resourceId / serviceId -> CASCADE; Appointment.serviceId /
    // resourceId, StaffResource.userId, CatalogImport.createdById / fileMediaId -> SET NULL.
    if (db.staffService) db.staffService = db.staffService.filter((l) => l.resourceId !== row.id && l.serviceId !== row.id);
    for (const ap of db.appointment ?? []) {
      if (ap.serviceId === row.id) ap.serviceId = null;
      if (ap.resourceId === row.id) ap.resourceId = null;
    }
    for (const r of db.staffResource ?? []) if (r.userId === row.id) r.userId = null;
    for (const c of db.catalogImport ?? []) {
      if (c.createdById === row.id) c.createdById = null;
      if (c.fileMediaId === row.id) c.fileMediaId = null;
    }
  }

  /** Snapshot every row (keeping object identity) so a failed array
   *  transaction can be undone like a Postgres rollback. */
  function snapshot() {
    const saved = Object.entries(db).map(([k, list]) => [k, list.map((r) => [r, { ...r }] as const)] as const);
    return () => {
      for (const [k, list] of saved) {
        db[k] = list.map(([ref, copy]) => {
          for (const key of Object.keys(ref)) delete ref[key];
          return Object.assign(ref, copy);
        });
      }
    };
  }

  const prisma: any = {
    db,
    channel: model("channel"),
    integration: model("integration"),
    conversation: model("conversation"),
    contact: model("contact"),
    message: model("message"),
    workspace: model("workspace"),
    campaign: model("campaign"),
    template: model("template"),
    workspaceMember: model("workspaceMember"),
    // SP-14: roles (membersWith) and SP-05 notifications (the downgrade alert).
    role: model("role"),
    notification: model("notification"),
    notificationPreference: model("notificationPreference"),
    campaignRecipient: model("campaignRecipient"),
    // SP-12 T2: follow-up actions (groups and tags).
    segment: model("segment"),
    segmentMember: model("segmentMember"),
    tag: model("tag"),
    // SP-13: partitions, custom fields (varMap) and header media.
    campaignBroadcast: model("campaignBroadcast"),
    customFieldDef: model("customFieldDef"),
    customFieldValue: model("customFieldValue"),
    media: model("media"),
    // SP-15
    adSource: model("adSource"),
    adReferral: model("adReferral"),
    adSpendDaily: model("adSpendDaily"),
    metaAdsConnection: model("metaAdsConnection"),
    metaLead: model("metaLead"),
    // SP-15 Task 2: MetaAdsConnection.connectedBy.
    user: model("user"),
    // SP-09: tickets, stages, attachments, activities and bookings.
    pipeline: model("pipeline"),
    ticket: model("ticket"),
    ticketStage: model("ticketStage"),
    ticketActivity: model("ticketActivity"),
    ticketAttachment: model("ticketAttachment"),
    lostReason: model("lostReason"),
    appointment: model("appointment"),
    // SP-10: the bookings catalog.
    service: model("service"),
    staffResource: model("staffResource"),
    staffService: model("staffService"),
    catalogImport: model("catalogImport"),
    $transaction: jest.fn(async (arg: any) => {
      if (typeof arg === "function") return arg(prisma);
      const restore = snapshot();
      const out: unknown[] = [];
      try {
        for (const q of arg) out.push(await q);
      } catch (e) {
        restore();
        throw e;
      }
      return out;
    }),
    // Raw SQL the channel code issues: the channelId write-back and the
    // lastInboundAt stamp (neither bumps updatedAt, as in Postgres).
    $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...vals: any[]) => {
      const sql = strings.join("?");
      if (/UPDATE "Conversation" SET "channelId"/.test(sql) && !/IS NULL/.test(sql)) {
        // merge: move every conversation of one channel to another
        const [to, workspaceId, from] = vals;
        const hit = db.conversation.filter((c) => c.workspaceId === workspaceId && c.channelId === from);
        hit.forEach((c) => (c.channelId = to));
        return hit.length;
      }
      if (/UPDATE "Conversation" SET "channelId"/.test(sql)) {
        const [channelId, id, workspaceId] = vals;
        const row = db.conversation.find((c) => c.id === id && c.workspaceId === workspaceId && !c.channelId);
        if (row) row.channelId = channelId;
        return row ? 1 : 0;
      }
      if (/UPDATE "CampaignRecipient"/.test(sql) && /jsonb_to_recordset/.test(sql)) {
        // SP-12 compare-and-set batch: vals = [json rows, workspaceId, campaignId]
        const [json, workspaceId, campaignId] = vals;
        const dates = ["prevUpdatedAt", "sentAt", "deliveredAt", "readAt"];
        let n = 0;
        for (const v of JSON.parse(json) as Row[]) {
          for (const k of dates) v[k] = v[k] == null ? null : new Date(v[k]);
          const r = db.campaignRecipient.find(
            (x) =>
              x.id === v.id &&
              x.workspaceId === workspaceId &&
              x.campaignId === campaignId &&
              x.status === v.prevStatus &&
              x.updatedAt instanceof Date &&
              x.updatedAt.getTime() === v.prevUpdatedAt.getTime(),
          );
          if (!r) continue;
          for (const k of ["status", "messageId", "sentAt", "deliveredAt", "readAt", "failureCode", "failureReason"]) r[k] = v[k];
          r.updatedAt = new Date(Math.max(Date.now(), r.updatedAt.getTime() + 1));
          n++;
        }
        return n;
      }
      if (/UPDATE "Campaign" SET "replied" = GREATEST\("replied", \?::int\)/.test(sql)) {
        // SP-12 R4: atomic GREATEST write of Campaign.replied
        const [n, id] = vals;
        const row = db.campaign.find((c) => c.id === id);
        if (row) row.replied = Math.max(row.replied ?? 0, Number(n));
        return row ? 1 : 0;
      }
      // SP-14 health claim: cooldown + lease in one statement. Like Postgres
      // raw SQL, neither the claim nor the fenced write touches updatedAt.
      if (/UPDATE "Channel" SET "healthAttemptedAt" = \?::timestamp\(3\)/.test(sql)) {
        // The fake only honours the exact guarded statement (a spec catches a dropped guard).
        if (!/WHERE "id" = \? AND "workspaceId" = \? AND \("healthAttemptedAt" IS NULL OR "healthAttemptedAt" <= \?::timestamp\(3\)\)$/.test(sql.trim()) || /updatedAt/.test(sql))
          throw new Error(`unexpected health claim SQL: ${sql}`);
        const [at, id, workspaceId, cutoff] = vals;
        const row = db.channel.find((c) => c.id === id && c.workspaceId === workspaceId);
        if (!row) return 0;
        const prev: Date | null = row.healthAttemptedAt ?? null;
        if (prev && prev.getTime() > new Date(cutoff).getTime()) return 0;
        row.healthAttemptedAt = new Date(at);
        return 1;
      }
      // SP-14 fenced health write.
      if (/UPDATE "Channel" SET "health" = \?::jsonb, "healthCheckedAt" = \?::timestamp\(3\)/.test(sql)) {
        if (!/WHERE "id" = \? AND "healthAttemptedAt" = \?::timestamp\(3\)$/.test(sql.trim()) || /updatedAt/.test(sql))
          throw new Error(`unexpected health write SQL: ${sql}`);
        const [json, at, id, token] = vals;
        const row = db.channel.find((c) => c.id === id);
        if (!row || !(row.healthAttemptedAt instanceof Date) || row.healthAttemptedAt.getTime() !== new Date(token).getTime()) return 0;
        row.health = JSON.parse(json);
        row.healthCheckedAt = at == null ? null : new Date(at);
        return 1;
      }
      // SP-14 final review I1: a re-pointed row drops its health (no updatedAt).
      if (/UPDATE "Channel" SET "health" = NULL/.test(sql)) {
        if (!/^UPDATE "Channel" SET "health" = NULL, "healthCheckedAt" = NULL, "healthAttemptedAt" = NULL WHERE "id" = \?$/.test(sql.trim()) || /updatedAt/.test(sql))
          throw new Error(`unexpected health clear SQL: ${sql}`);
        const [id] = vals;
        const row = db.channel.find((c) => c.id === id);
        if (!row) return 0;
        Object.assign(row, { health: null, healthCheckedAt: null, healthAttemptedAt: null });
        return 1;
      }
      // SP-15 Meta Ads claims (sync cadence and the live-check cooldown). Like
      // Postgres raw SQL, neither touches updatedAt; only the exact guarded
      // statements are honoured (a spec catches a dropped guard).
      if (/UPDATE "MetaAdsConnection" SET "syncAttemptedAt"/.test(sql)) {
        if (!/^UPDATE "MetaAdsConnection" SET "syncAttemptedAt" = \?::timestamp\(3\) WHERE "id" = \? AND "status" = 'active' AND \("syncAttemptedAt" IS NULL OR "syncAttemptedAt" <= \?::timestamp\(3\)\)$/.test(sql.trim()))
          throw new Error(`unexpected meta ads sync claim SQL: ${sql}`);
        const [at, id, cutoff] = vals;
        const row = (db.metaAdsConnection ?? []).find((c) => c.id === id && c.status === "active");
        if (!row) return 0;
        const prev: Date | null = row.syncAttemptedAt ?? null;
        if (prev && prev.getTime() > new Date(cutoff).getTime()) return 0;
        row.syncAttemptedAt = new Date(at);
        return 1;
      }
      if (/UPDATE "MetaAdsConnection" SET "checkAttemptedAt"/.test(sql)) {
        if (!/^UPDATE "MetaAdsConnection" SET "checkAttemptedAt" = \?::timestamp\(3\) WHERE "workspaceId" = \? AND \("checkAttemptedAt" IS NULL OR "checkAttemptedAt" <= \?::timestamp\(3\)\)$/.test(sql.trim()))
          throw new Error(`unexpected meta ads check claim SQL: ${sql}`);
        const [at, workspaceId, cutoff] = vals;
        const row = (db.metaAdsConnection ?? []).find((c) => c.workspaceId === workspaceId);
        if (!row) return 0;
        const prev: Date | null = row.checkAttemptedAt ?? null;
        if (prev && prev.getTime() > new Date(cutoff).getTime()) return 0;
        row.checkAttemptedAt = new Date(at);
        return 1;
      }
      if (/UPDATE "Channel" SET "lastInboundAt"/.test(sql)) {
        const [id] = vals;
        const row = db.channel.find((c) => c.id === id);
        if (row) row.lastInboundAt = new Date();
        return row ? 1 : 0;
      }
      return 0;
    }),
  };
  return prisma;
}

/**
 * SP-10: opt-in advisory locks for the double (shared by the SP-10 specs).
 * Inside `$transaction(fn)`, `SELECT pg_advisory_xact_lock(...)` takes a real
 * per-key async mutex held until the callback settles, so concurrent callers
 * queue like Postgres sessions. The key is the statement with its values
 * inlined, so `hashtext(${key})` and `hashtext('p:' || ${id})` both work.
 * Re-entrant within one transaction, like Postgres. The call still reaches
 * `prisma.$executeRaw` (and its mock) for assertions. Array transactions and
 * statements outside a transaction are unchanged.
 *
 * Returns `held()` (the keys held right now) and `order` (every acquisition,
 * in order) for interleaving assertions.
 */
export function withAdvisoryLocks(prisma: any): { held: () => string[]; order: string[] } {
  const tails = new Map<string, Promise<void>>();
  const holders = new Set<string>();
  const order: string[] = [];
  const baseTx = prisma.$transaction;
  const keyOf = (strings: TemplateStringsArray, vals: any[]) =>
    strings.reduce((acc, s, i) => acc + s + (i < vals.length ? String(vals[i]) : ""), "");

  async function acquire(key: string): Promise<() => void> {
    const prev = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => mine);
    tails.set(key, tail);
    await prev;
    holders.add(key);
    order.push(key);
    return () => {
      holders.delete(key);
      if (tails.get(key) === tail) tails.delete(key);
      release();
    };
  }

  prisma.$transaction = jest.fn(async (arg: any) => {
    if (typeof arg !== "function") return baseTx(arg);
    const mine = new Map<string, () => void>();
    const tx = Object.create(prisma);
    tx.$executeRaw = async (strings: TemplateStringsArray, ...vals: any[]) => {
      if (/pg_advisory_xact_lock/.test(strings.join("?"))) {
        const key = keyOf(strings, vals);
        if (!mine.has(key)) mine.set(key, await acquire(key));
      }
      return prisma.$executeRaw(strings, ...vals);
    };
    try {
      return await arg(tx);
    } finally {
      for (const release of mine.values()) release();
    }
  });
  return { held: () => [...holders], order };
}

function lazy<T>(run: () => T): PromiseLike<T> & { catch: Promise<T>["catch"] } {
  let p: Promise<T> | undefined;
  const get = () => (p ??= Promise.resolve().then(run));
  return {
    then: (ok, bad) => get().then(ok, bad),
    catch: (bad) => get().catch(bad),
  } as PromiseLike<T> & { catch: Promise<T>["catch"] };
}

function p2025(): Error {
  const e = new Error("Record to update not found") as Error & { code: string };
  e.code = "P2025";
  return e;
}

function applyData(row: Row, data: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(data ?? {})) {
    // Like Prisma, an undefined field is "leave it alone" (SP-09).
    if (v === undefined) continue;
    // Prisma.DbNull / Prisma.JsonNull on a Json column store SQL/JSON null.
    if (v && typeof v === "object" && ["DbNull", "JsonNull"].includes((v as object).constructor?.name)) {
      out[k] = null;
      continue;
    }
    if (v && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v)) {
      if ("increment" in v) {
        out[k] = (row[k] ?? 0) + (v as any).increment;
        continue;
      }
      if ("set" in v) {
        out[k] = (v as any).set;
        continue;
      }
    }
    out[k] = v;
  }
  return out;
}
