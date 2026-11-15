/**
 * SP-16 in-memory audience evaluator and Prisma double (a test helper, not a
 * runtime file; same convention as channels/test-prisma.ts).
 *
 * `matchesWhere` evaluates a `Prisma.*WhereInput` over fixture tables with
 * Postgres semantics for the subset the audience compiler emits:
 *  - scalars: equality, `null`, `equals` (+ `mode: "insensitive"`), `in`,
 *    `notIn`, `not`, `contains` (+ mode), `gt`/`gte`/`lt`/`lte` (dates,
 *    numbers, strings);
 *  - `AND` / `OR` / `NOT` (object or array);
 *  - `some` / `none` / `every` on contact → conversations (→ messages),
 *    tickets (→ stage, a to-one), segmentMembers, fieldValues,
 *    campaignRecipients and activities;
 *  - SP-02's Json `value` filters (`equals`, `string_contains`, `gt`, `lt`).
 * It THROWS on any operator or relation it does not know, so a compiler
 * change cannot pass by being ignored.
 *
 * `createAudienceDb` wraps the tables in the Prisma surface the segments
 * service uses, and records every call for the specs.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Prisma } from "@prisma/client";

export type Row = Record<string, any>;
export interface AudienceTables {
  contact: Row[];
  conversation: Row[];
  message: Row[];
  ticket: Row[];
  ticketStage: Row[];
  pipeline: Row[];
  segment: Row[];
  segmentMember: Row[];
  customFieldDef: Row[];
  customFieldValue: Row[];
  campaign: Row[];
  campaignRecipient: Row[];
  activity: Row[];
  workspace: Row[];
  /** SP-16 Task 2: the tag catalog (safe tag deletes). */
  tag: Row[];
}

export function emptyTables(): AudienceTables {
  return {
    contact: [],
    conversation: [],
    message: [],
    ticket: [],
    ticketStage: [],
    pipeline: [],
    segment: [],
    segmentMember: [],
    customFieldDef: [],
    customFieldValue: [],
    campaign: [],
    campaignRecipient: [],
    activity: [],
    workspace: [],
    tag: [],
  };
}

type Rel = { table: keyof AudienceTables; kind: "many" | "one"; fk: string; ownKey?: string };

/** Relations by model: `many` rows where row[fk] === parent.id; `one` row whose id === parent[ownKey]. */
const RELATIONS: Record<string, Record<string, Rel>> = {
  contact: {
    conversations: { table: "conversation", kind: "many", fk: "contactId" },
    tickets: { table: "ticket", kind: "many", fk: "contactId" },
    segmentMembers: { table: "segmentMember", kind: "many", fk: "contactId" },
    fieldValues: { table: "customFieldValue", kind: "many", fk: "contactId" },
    campaignRecipients: { table: "campaignRecipient", kind: "many", fk: "contactId" },
    activities: { table: "activity", kind: "many", fk: "contactId" },
  },
  conversation: { messages: { table: "message", kind: "many", fk: "conversationId" } },
  ticket: {
    stage: { table: "ticketStage", kind: "one", fk: "id", ownKey: "stageId" },
    pipeline: { table: "pipeline", kind: "one", fk: "id", ownKey: "pipelineId" },
  },
};

const MODEL_OF: Record<string, string> = {
  conversation: "conversation",
  message: "message",
  ticket: "ticket",
  ticketStage: "ticketStage",
  pipeline: "pipeline",
  segmentMember: "segmentMember",
  customFieldValue: "customFieldValue",
  campaignRecipient: "campaignRecipient",
  activity: "activity",
};

/** Json columns (compared as Json values, no `mode`). */
const JSON_COLUMNS = new Set(["customFieldValue.value", "segment.rules"]);

const SCALAR_OPS = new Set(["equals", "in", "notIn", "not", "contains", "gt", "gte", "lt", "lte", "mode", "string_contains"]);

function cmp(a: any, b: any): number | null {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  if (a instanceof Date || b instanceof Date) {
    const x = a instanceof Date ? a.getTime() : new Date(a).getTime();
    const y = b instanceof Date ? b.getTime() : new Date(b).getTime();
    return x - y;
  }
  if (typeof a !== typeof b) return null; // Json: a number never compares with a string
  if (typeof a === "number") return a - b;
  if (typeof a === "string") return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === "boolean") return a === b ? 0 : null;
  return null;
}

function eq(a: any, b: any, insensitive: boolean): boolean {
  if (a instanceof Date || b instanceof Date) return cmp(a, b) === 0;
  if (insensitive && typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

function matchScalar(v: any, cond: any, col: string): boolean {
  if (cond === null) return v === null || v === undefined;
  if (cond instanceof Date || typeof cond !== "object" || Array.isArray(cond)) {
    return v !== null && v !== undefined && eq(v, cond, false);
  }
  for (const k of Object.keys(cond)) {
    if (!SCALAR_OPS.has(k)) throw new Error(`audience-test-db: unsupported scalar operator "${k}" on ${col}`);
  }
  const ins = cond.mode === "insensitive";
  if (cond.mode !== undefined && cond.mode !== "insensitive" && cond.mode !== "default") {
    throw new Error(`audience-test-db: unsupported mode ${cond.mode}`);
  }
  if (JSON_COLUMNS.has(col) && ins) throw new Error("audience-test-db: Json filters take no mode");
  if ("equals" in cond) {
    if (cond.equals === null) {
      if (v !== null && v !== undefined) return false;
    } else if (v === null || v === undefined || !eq(v, cond.equals, ins)) return false;
  }
  if ("in" in cond) {
    if (v === null || v === undefined || !(cond.in as any[]).some((x) => eq(v, x, ins))) return false;
  }
  if ("notIn" in cond) {
    if (v === null || v === undefined || (cond.notIn as any[]).some((x) => eq(v, x, ins))) return false;
  }
  if ("not" in cond) {
    if (cond.not === null) {
      if (v === null || v === undefined) return false;
    } else if (typeof cond.not === "object" && !(cond.not instanceof Date)) {
      if (v === null || v === undefined || matchScalar(v, cond.not, col)) return false;
    } else if (v === null || v === undefined || eq(v, cond.not, ins)) return false;
  }
  if ("contains" in cond) {
    if (typeof v !== "string") return false;
    const hay = ins ? v.toLowerCase() : v;
    const needle = ins ? String(cond.contains).toLowerCase() : String(cond.contains);
    if (!hay.includes(needle)) return false;
  }
  if ("string_contains" in cond) {
    if (typeof v !== "string" || !v.includes(cond.string_contains)) return false;
  }
  for (const [op, test] of [
    ["gt", (c: number) => c > 0],
    ["gte", (c: number) => c >= 0],
    ["lt", (c: number) => c < 0],
    ["lte", (c: number) => c <= 0],
  ] as const) {
    if (op in cond) {
      const c = cmp(v, cond[op]);
      if (c === null || !test(c)) return false;
    }
  }
  return true;
}

/** Evaluate `where` against one row of `model`. Throws on anything unknown. */
export function matchesWhere(db: AudienceTables, model: string, row: Row, where: any): boolean {
  if (where === undefined || where === null) return true;
  if (typeof where !== "object" || Array.isArray(where)) throw new Error(`audience-test-db: bad where on ${model}`);
  for (const [k, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (k === "AND") {
      const list = Array.isArray(cond) ? cond : [cond];
      if (!list.every((w) => matchesWhere(db, model, row, w))) return false;
      continue;
    }
    if (k === "OR") {
      if (!Array.isArray(cond)) throw new Error("audience-test-db: OR takes an array");
      if (!cond.some((w) => matchesWhere(db, model, row, w))) return false;
      continue;
    }
    if (k === "NOT") {
      const list = Array.isArray(cond) ? cond : [cond];
      if (list.some((w) => matchesWhere(db, model, row, w))) return false;
      continue;
    }
    const rel = RELATIONS[model]?.[k];
    if (rel) {
      const target = MODEL_OF[rel.table];
      if (rel.kind === "one") {
        const c = cond as any;
        const inner = c && typeof c === "object" && ("is" in c || "isNot" in c) ? c : { is: c };
        const linked = db[rel.table].find((r) => r.id === row[rel.ownKey!]);
        if ("is" in inner) {
          if (inner.is === null ? !!linked : !linked || !matchesWhere(db, target, linked, inner.is)) return false;
        }
        if ("isNot" in inner) {
          if (inner.isNot === null ? !linked : !!linked && matchesWhere(db, target, linked, inner.isNot)) return false;
        }
        continue;
      }
      const c = cond as any;
      for (const op of Object.keys(c)) {
        if (!["some", "none", "every"].includes(op)) throw new Error(`audience-test-db: unsupported relation op ${op} on ${model}.${k}`);
      }
      const children = db[rel.table].filter((r) => r[rel.fk] === row.id);
      if ("some" in c && !children.some((ch) => matchesWhere(db, target, ch, c.some))) return false;
      if ("none" in c && children.some((ch) => matchesWhere(db, target, ch, c.none))) return false;
      if ("every" in c && !children.every((ch) => matchesWhere(db, target, ch, c.every))) return false;
      continue;
    }
    if (model === "contact" && !CONTACT_COLUMNS.has(k)) throw new Error(`audience-test-db: unknown Contact field ${k}`);
    if (!matchScalar(row[k], cond, `${model}.${k}`)) return false;
  }
  return true;
}

const CONTACT_COLUMNS = new Set([
  "id",
  "workspaceId",
  "name",
  "phone",
  "email",
  "industry",
  "lifecycle",
  "source",
  "tags",
  "notALead",
  "marketingOptOut",
  "ownerId",
  "createdAt",
  "updatedAt",
  "hjzClientId",
]);

/** Contact ids matching `where`, sorted. */
export function evaluateContacts(db: AudienceTables, where: Prisma.ContactWhereInput): string[] {
  return db.contact.filter((c) => matchesWhere(db, "contact", c, where)).map((c) => c.id).sort();
}

// ─── Prisma double ──────────────────────────────────────────────────────

function project(row: Row, select: any): Row {
  if (!select) return { ...row };
  const out: Row = {};
  for (const [k, v] of Object.entries(select)) if (v) out[k] = row[k];
  return out;
}

function sortRows(rows: Row[], orderBy: any): Row[] {
  if (!orderBy) return rows;
  const list = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Array<Record<string, "asc" | "desc">>;
  return [...rows].sort((a, b) => {
    for (const o of list) {
      const [k, dir] = Object.entries(o)[0];
      const c = cmp(a[k], b[k]) ?? 0;
      if (c !== 0) return dir === "desc" ? -c : c;
    }
    return 0;
  });
}

/** `id > x` found at the top of the where or inside its top-level AND (a paging shortcut only; the full where is still evaluated). */
function idLowerBound(where: any): string | null {
  if (!where || typeof where !== "object") return null;
  if (where.id && typeof where.id === "object" && typeof where.id.gt === "string") return where.id.gt;
  const and = Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : [];
  for (const w of and) {
    const b = idLowerBound(w);
    if (b !== null) return b;
  }
  return null;
}

export interface AudienceDbCall {
  model: string;
  op: string;
  args: any;
  tx: number | null;
}

export interface AudienceDbOptions {
  /** Run interactive transactions one at a time (a stand-in for the advisory lock). */
  serializeTransactions?: boolean;
  /**
   * SP-16 Task 2: emulate a raw `$executeRaw` statement the helper does not
   * know (for example the tag SQL on `Contact.tags`). Return the affected row
   * count, or `undefined` to fall through to the built-in handling.
   */
  raw?: (sql: string, values: unknown[], db: AudienceTables) => number | undefined;
}

let idSeq = 0;

export function createAudienceDb(tables: Partial<AudienceTables> = {}, opts: AudienceDbOptions = {}) {
  const db: AudienceTables = { ...emptyTables(), ...tables };
  const calls: AudienceDbCall[] = [];
  let txSeq = 0;
  let chain: Promise<unknown> = Promise.resolve();
  let sortedIds: { len: number; rows: Row[] } | null = null;

  const contactsById = () => {
    if (!sortedIds || sortedIds.len !== db.contact.length) {
      sortedIds = { len: db.contact.length, rows: [...db.contact].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) };
    }
    return sortedIds.rows;
  };

  const make = (txId: number | null) => {
    const log = (model: string, op: string, args: any) => calls.push({ model, op, args, tx: txId });
    const generic = (model: keyof AudienceTables) => ({
      findMany: async (args: any = {}) => {
        log(model, "findMany", args);
        let rows = db[model].filter((r) => matchesWhere(db, model, r, args.where));
        rows = sortRows(rows, args.orderBy);
        if (args.skip) rows = rows.slice(args.skip);
        if (args.take !== undefined) rows = rows.slice(0, args.take);
        return rows.map((r) => project(r, args.select));
      },
      findFirst: async (args: any = {}) => {
        log(model, "findFirst", args);
        const r = sortRows(db[model].filter((x) => matchesWhere(db, model, x, args.where)), args.orderBy)[0];
        return r ? project(r, args.select) : null;
      },
      findUnique: async (args: any = {}) => {
        log(model, "findUnique", args);
        const r = db[model].find((x) => matchesWhere(db, model, x, args.where));
        return r ? project(r, args.select) : null;
      },
      count: async (args: any = {}) => {
        log(model, "count", args);
        return db[model].filter((r) => matchesWhere(db, model, r, args.where)).length;
      },
      update: async (args: any) => {
        log(model, "update", args);
        const row = db[model].find((r) => matchesWhere(db, model, r, args.where));
        if (!row) throw Object.assign(new Error("Record to update not found."), { code: "P2025" });
        Object.assign(row, normalizeData(args.data, row));
        return project(row, args.select);
      },
      delete: async (args: any) => {
        log(model, "delete", args);
        const i = db[model].findIndex((r) => matchesWhere(db, model, r, args.where));
        if (i < 0) throw Object.assign(new Error("Record to delete does not exist."), { code: "P2025" });
        const [row] = db[model].splice(i, 1);
        return project(row, args.select);
      },
      deleteMany: async (args: any = {}) => {
        log(model, "deleteMany", args);
        const keep = db[model].filter((r) => !matchesWhere(db, model, r, args.where));
        const count = db[model].length - keep.length;
        db[model].splice(0, db[model].length, ...keep);
        return { count };
      },
    });

    const contact = {
      ...generic("contact"),
      findMany: async (args: any = {}) => {
        log("contact", "findMany", args);
        const take: number | undefined = args.take;
        const asc =
          args.orderBy &&
          !Array.isArray(args.orderBy) &&
          Object.keys(args.orderBy).length === 1 &&
          args.orderBy.id === "asc";
        if (asc && take !== undefined && !args.skip) {
          const all = contactsById();
          const lb = idLowerBound(args.where);
          let i = 0;
          if (lb !== null) {
            let lo = 0;
            let hi = all.length;
            while (lo < hi) {
              const mid = (lo + hi) >> 1;
              if (all[mid].id <= lb) lo = mid + 1;
              else hi = mid;
            }
            i = lo;
          }
          const out: Row[] = [];
          for (; i < all.length && out.length < take; i++) {
            if (matchesWhere(db, "contact", all[i], args.where)) out.push(project(all[i], args.select));
          }
          return out;
        }
        let rows = db.contact.filter((r) => matchesWhere(db, "contact", r, args.where));
        rows = sortRows(rows, args.orderBy);
        if (args.skip) rows = rows.slice(args.skip);
        if (take !== undefined) rows = rows.slice(0, take);
        return rows.map((r) => project(r, args.select));
      },
    };

    const segment = {
      ...generic("segment"),
      create: async (args: any) => {
        log("segment", "create", args);
        const now = new Date();
        const row: Row = {
          id: `seg_${++idSeq}`,
          nameAr: null,
          color: null,
          filter: "{}",
          origin: "crm",
          rules: null,
          version: 0,
          memberCount: null,
          countedAt: null,
          createdAt: now,
          updatedAt: now,
          ...normalizeData(args.data, {}),
        };
        db.segment.push(row);
        return project(row, args.select);
      },
      update: async (args: any) => {
        log("segment", "update", args);
        const row = db.segment.find((r) => matchesWhere(db, "segment", r, args.where));
        if (!row) throw Object.assign(new Error("Record to update not found."), { code: "P2025" });
        Object.assign(row, normalizeData(args.data, row), { updatedAt: new Date(Date.now() + 1) });
        return project(row, args.select);
      },
    };

    return {
      contact,
      segment,
      segmentMember: generic("segmentMember"),
      pipeline: generic("pipeline"),
      ticketStage: generic("ticketStage"),
      customFieldDef: generic("customFieldDef"),
      campaign: generic("campaign"),
      workspace: generic("workspace"),
      tag: generic("tag"),
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join("?");
        log("$raw", "$executeRaw", { sql, values });
        const custom = opts.raw?.(sql, values, db);
        if (custom !== undefined) return custom;
        // SP-16 live-verification fixes: the batched audience rewrite and the count-cache clear.
        if (/UPDATE "Segment" AS s/.test(sql) && /jsonb_to_recordset/.test(sql)) {
          const [payload, ws] = values as [string, string];
          let n = 0;
          for (const v of JSON.parse(payload) as Array<{ id: string; rules: unknown; filter: string }>) {
            const row = db.segment.find((r) => r.id === v.id && r.workspaceId === ws);
            if (!row) continue;
            Object.assign(row, { rules: v.rules ?? null, filter: v.filter, version: (row.version ?? 0) + 1, updatedAt: new Date() });
            n++;
          }
          return n;
        }
        if (/UPDATE "Segment" SET "memberCount" = NULL, "countedAt" = NULL/.test(sql)) {
          const [ws, ids] = values as [string, string[]];
          let n = 0;
          for (const row of db.segment) {
            if (row.workspaceId !== ws || !ids.includes(row.id)) continue;
            Object.assign(row, { memberCount: null, countedAt: null });
            n++;
          }
          return n;
        }
        if (/UPDATE "Segment" SET "memberCount"/.test(sql)) {
          const [count, at, id, ws] = values as [number, Date, string, string];
          const row = db.segment.find((r) => r.id === id && r.workspaceId === ws);
          if (row) Object.assign(row, { memberCount: count, countedAt: at });
          return row ? 1 : 0;
        }
        return 1;
      },
      $executeRawUnsafe: async (sql: string) => {
        log("$raw", "$executeRawUnsafe", { sql });
        return 0;
      },
    };
  };

  const root = make(null);
  const client = {
    ...root,
    $transaction: async (fn: any, options?: any) => {
      if (typeof fn !== "function") throw new Error("audience-test-db: only interactive transactions");
      const id = ++txSeq;
      calls.push({ model: "$tx", op: "begin", args: options, tx: id });
      const run = async () => {
        // A snapshot so a thrown error rolls every table back, like Postgres.
        const snapshot = Object.fromEntries(
          (Object.keys(db) as Array<keyof AudienceTables>).map((k) => [k, db[k].map((r) => ({ ...r }))]),
        ) as unknown as AudienceTables;
        try {
          return await fn(client.__tx(id));
        } catch (e) {
          for (const k of Object.keys(snapshot) as Array<keyof AudienceTables>) db[k].splice(0, db[k].length, ...snapshot[k]);
          throw e;
        } finally {
          calls.push({ model: "$tx", op: "end", args: null, tx: id });
        }
      };
      if (!opts.serializeTransactions) return run();
      const p = chain.then(run, run);
      chain = p.catch(() => undefined);
      return p;
    },
    /** A transaction client bound to `id` (its calls carry that tx id). Overridable by specs. */
    __tx: (id: number) => make(id),
  };
  return { db, calls, prisma: client };
}

function normalizeData(data: Row, current: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(data ?? {})) {
    if (v === undefined) continue;
    if (v === Prisma.DbNull || v === Prisma.JsonNull) out[k] = null;
    else if (v && typeof v === "object" && !(v instanceof Date) && "increment" in v) out[k] = (current[k] ?? 0) + (v as any).increment;
    else out[k] = v;
  }
  return out;
}

export type AudienceDb = ReturnType<typeof createAudienceDb>;
