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

type Row = Record<string, any>;
export type Tables = Record<string, Row[]>;

let seq = 0;
const nextId = (p: string) => `${p}_${++seq}`;

function matchValue(v: any, cond: any): boolean {
  if (cond === null) return v === null || v === undefined;
  if (cond instanceof Date) return v instanceof Date && v.getTime() === cond.getTime();
  if (typeof cond === "object" && !Array.isArray(cond)) {
    if ("in" in cond && !(cond.in as any[]).includes(v)) return false;
    if ("notIn" in cond && (cond.notIn as any[]).includes(v)) return false;
    if ("not" in cond) {
      if (cond.not === null ? v === null || v === undefined : matchValue(v, cond.not)) return false;
    }
    if ("equals" in cond && v !== cond.equals) return false;
    if ("contains" in cond && !String(v ?? "").includes(cond.contains)) return false;
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
      if (!Object.entries(cond).every(([ck, cv]) => row[ck] === cv)) return false;
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
      const [k, dir] = Object.entries(o)[0] as [string, string];
      const av = a[k] instanceof Date ? a[k].getTime() : a[k];
      const bv = b[k] instanceof Date ? b[k].getTime() : b[k];
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
  }),
  integration: () => ({ provider: "meta", pageId: null, pageName: null, accessToken: null, raw: null }),
  conversation: () => ({ channelId: null, externalId: null, aiEnabled: false, aiPausedAt: null, unread: 0 }),
  // SP-12
  campaign: () => ({ recipientTracking: false, recipientsSyncedAt: null, recipientSyncSkip: 0, scheduledAt: null, launchedAt: null }),
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
  }),
};

/** SP-12: @@unique([campaignId, phone]) (NULL phones are distinct, as in Postgres). */
function recipientClash(rows: Row[], row: Row): boolean {
  return row.phone != null && rows.some((o) => o !== row && o.campaignId === row.campaignId && o.phone === row.phone);
}

function project(row: Row, select?: any, include?: any, db?: Tables): Row {
  let out: Row = { ...row };
  if (include && db) {
    for (const [k, v] of Object.entries(include)) {
      if (!v) continue;
      if (k === "contact") out.contact = (db.contact ?? []).find((c) => c.id === row.contactId) ?? null;
      if (k === "labels") out.labels = [];
      if (k === "messages") out.messages = (db.message ?? []).filter((m) => m.conversationId === row.id);
    }
  }
  if (select) {
    const picked: Row = {};
    for (const [k, v] of Object.entries(select)) if (v) picked[k] = out[k];
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
    ...seed,
  } as Tables;

  const model = (name: string) => {
    const rows = () => (db[name] ??= []);
    const write = (row: Row) => {
      if (name === "channel") checkChannelUniques(rows(), row);
    };
    // Like Prisma, every call returns a LAZY thenable: nothing runs until it
    // is awaited, so an array $transaction can snapshot first and roll back.
    const op = (fn: (a: any) => any) => jest.fn((a: any = {}) => lazy(() => fn(a)));
    return {
      findMany: op((a) => {
        let r = rows().filter((x) => matches(x, a.where, db, name));
        r = sortRows(r, a.orderBy);
        if (a.take) r = r.slice(0, a.take);
        return r.map((x) => project(x, a.select, a.include, db));
      }),
      findFirst: op((a) => {
        const r = sortRows(rows().filter((x) => matches(x, a.where, db, name)), a.orderBy)[0];
        return r ? project(r, a.select, a.include, db) : null;
      }),
      findUnique: op((a) => {
        const r = rows().find((x) => matches(x, a.where, db, name));
        return r ? project(r, a.select, a.include, db) : null;
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
        write(row);
        rows().push(row);
        return project(row, a.select, a.include, db);
      }),
      update: op((a) => {
        const row = rows().find((x) => matches(x, a.where, db, name));
        if (!row) throw p2025();
        const next = { ...row, ...applyData(row, a.data), updatedAt: new Date() };
        if (name === "channel") checkChannelUniques(rows().filter((x) => x !== row), next);
        Object.assign(row, next);
        return project(row, a.select, a.include, db);
      }),
      updateMany: op((a) => {
        const hit = rows().filter((x) => matches(x, a.where, db, name));
        for (const row of hit) {
          const next = { ...row, ...applyData(row, a.data), updatedAt: new Date() };
          if (name === "channel") checkChannelUniques(rows().filter((x) => x !== row), next);
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
    campaignRecipient: model("campaignRecipient"),
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
