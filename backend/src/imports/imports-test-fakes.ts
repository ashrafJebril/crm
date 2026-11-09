/* Shared in-memory fakes for the imports specs (not a spec itself). */
import { ImportRunnerService } from "./import-runner.service";
import { ImportsService } from "./imports.service";

export interface FakeContact {
  id: string;
  workspaceId: string;
  name: string;
  phone: string | null;
  email: string | null;
  tags: string;
  [k: string]: unknown;
}

const inList = (v: unknown, list: unknown[] | undefined) => !list || list.includes(v);

export class FakePrisma {
  contacts = new Map<string, FakeContact>();
  jobs = new Map<string, any>();
  segments = new Map<string, any>();
  members: { segmentId: string; contactId: string }[] = [];
  customValues: { defId: string; contactId: string; value: unknown }[] = [];
  defs: any[] = [];
  workspaceMembers: any[] = [
    { userId: "u1", user: { id: "u1", name: "Owner One", email: "owner@x.com" } },
    { userId: "u2", user: { id: "u2", name: "Agent Two", email: "agent@x.com" } },
  ];
  pipelines: Array<{ id: string; workspaceId: string; archivedAt?: Date | null }> = [{ id: "p1", workspaceId: "ws1" }];
  stages = [{ id: "s1", workspaceId: "ws1", pipelineId: "p1" }];
  timezone = "Asia/Dubai";
  jobUpdates: any[] = [];
  /** Hook invoked after each importJob.updateMany (tests cancel from here). */
  onJobUpdate?: (data: any) => void;
  private seq = 0;
  private digitsCache = new Map<string, string>();

  workspace = { findFirst: async () => ({ timezone: this.timezone }) };
  workspaceMember = { findMany: async () => this.workspaceMembers };
  customFieldDef = { findMany: async () => this.defs };
  pipeline = {
    findFirst: async ({ where }: any) => this.pipelines.find((p) => p.id === where.id && p.workspaceId === where.workspaceId) ?? null,
  };
  ticketStage = {
    findFirst: async ({ where }: any) =>
      this.stages.find((s) => s.id === where.id && s.workspaceId === where.workspaceId && s.pipelineId === where.pipelineId) ?? null,
  };
  contact = {
    findMany: async ({ where }: any) => {
      let rows = [...this.contacts.values()].filter((c) => c.workspaceId === where.workspaceId);
      if (where.id?.in) rows = rows.filter((c) => where.id.in.includes(c.id));
      if (where.OR) {
        const phones = new Set<unknown>(where.OR.flatMap((cl: any) => cl.phone?.in ?? []));
        const emails = new Set<unknown>(where.OR.flatMap((cl: any) => cl.email?.in ?? []));
        rows = rows.filter((c) => phones.has(c.phone) || emails.has(c.email));
      }
      return rows;
    },
    createMany: async ({ data }: any) => {
      let n = 0;
      for (const d of data) {
        if (this.contacts.has(d.id)) continue;
        this.contacts.set(d.id, { ...d });
        n += 1;
      }
      return { count: n };
    },
    update: async ({ where, data }: any) => {
      const c = this.contacts.get(where.id)!;
      Object.assign(c, data);
      return c;
    },
  };
  /** Fake of the batch matching query: values are (workspaceId, digitsVariants, emails). */
  $queryRaw = async (_s: unknown, ws: string, digits: string[], emails: string[]) => {
    const d = new Set(digits);
    const e = new Set(emails);
    const out: FakeContact[] = [];
    for (const c of this.contacts.values()) {
      if (c.workspaceId !== ws) continue;
      let dg = this.digitsCache.get(c.id);
      if (dg === undefined) {
        dg = c.phone ? String(c.phone).replace(/\D/g, "") : "";
        this.digitsCache.set(c.id, dg);
      }
      if ((dg && d.has(dg)) || (c.email && e.has(String(c.email).toLowerCase()))) out.push(c);
    }
    return out;
  };
  customFieldValue = {
    deleteMany: async ({ where }: any) => {
      const before = this.customValues.length;
      this.customValues = this.customValues.filter(
        (v) => !(v.defId === where.defId && where.contactId.in.includes(v.contactId)),
      );
      return { count: before - this.customValues.length };
    },
    createMany: async ({ data }: any) => {
      for (const d of data) {
        if (!this.customValues.some((v) => v.defId === d.defId && v.contactId === d.contactId)) this.customValues.push({ ...d });
      }
      return { count: data.length };
    },
  };
  segment = {
    findFirst: async ({ where }: any) => {
      const s = this.segments.get(where.id);
      return s && s.workspaceId === where.workspaceId ? s : null;
    },
    create: async ({ data }: any) => {
      const s = { id: `seg${++this.seq}`, ...data };
      this.segments.set(s.id, s);
      return s;
    },
  };
  segmentMember = {
    createMany: async ({ data }: any) => {
      let n = 0;
      for (const d of data) {
        if (!this.members.some((m) => m.segmentId === d.segmentId && m.contactId === d.contactId)) {
          this.members.push({ segmentId: d.segmentId, contactId: d.contactId });
          n += 1;
        }
      }
      return { count: n };
    },
  };
  importJob = {
    create: async ({ data }: any) => {
      const j = {
        id: `job${++this.seq}`,
        processed: 0,
        created: 0,
        updated: 0,
        skipped: 0,
        failed: 0,
        duplicateInFile: 0,
        errors: [],
        mapping: null,
        options: null,
        heartbeatAt: null,
        startedAt: null,
        finishedAt: null,
        createdAt: new Date(),
        ...data,
      };
      this.jobs.set(j.id, j);
      return { ...j };
    },
    findFirst: async ({ where }: any) => {
      const j = this.jobs.get(where.id);
      if (!j || (where.workspaceId && j.workspaceId !== where.workspaceId)) return null;
      return { ...j };
    },
    findMany: async ({ where, take }: any) => {
      const rows = [...this.jobs.values()].filter((j) => {
        if (where.workspaceId && j.workspaceId !== where.workspaceId) return false;
        if (where.status && typeof where.status === "string" && j.status !== where.status) return false;
        if (where.status?.in && !where.status.in.includes(j.status)) return false;
        if (where.createdAt?.lt && !(j.createdAt < where.createdAt.lt)) return false;
        if (where.OR) {
          const cutoff = where.OR[0].heartbeatAt.lt as Date;
          return j.heartbeatAt ? j.heartbeatAt < cutoff : false;
        }
        return true;
      });
      return rows.slice(0, take).map((j) => ({ ...j }));
    },
    updateMany: async ({ where, data }: any) => {
      const j = this.jobs.get(where.id);
      if (!j || (where.workspaceId && j.workspaceId !== where.workspaceId)) return { count: 0 };
      if (where.status) {
        const ok = typeof where.status === "string" ? j.status === where.status : inList(j.status, where.status.in);
        if (!ok) return { count: 0 };
      }
      if ("heartbeatAt" in where && where.heartbeatAt?.getTime?.() !== j.heartbeatAt?.getTime?.()) return { count: 0 };
      Object.assign(j, data);
      this.jobUpdates.push({ id: where.id, ...data });
      this.onJobUpdate?.(data);
      return { count: 1 };
    },
  };
  $transaction = async (arg: any) => (Array.isArray(arg) ? Promise.all(arg) : arg(this));
}

export function seedJob(prisma: FakePrisma, over: Record<string, unknown> = {}) {
  const job = {
    id: "job-seed",
    workspaceId: "ws1",
    createdById: "u1",
    kind: "contacts",
    status: "running",
    fileMediaId: "m1",
    fileName: "contacts.csv",
    totalRows: 0,
    processed: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    duplicateInFile: 0,
    errors: [],
    mapping: { Name: "name", Phone: "phone", Email: "email" },
    options: { matchBy: "phone_then_email", updateExisting: false },
    heartbeatAt: new Date(),
    startedAt: new Date(),
    finishedAt: null,
    createdAt: new Date(),
    ...over,
  };
  prisma.jobs.set(job.id, job);
  return job;
}

export function makeRunner(prisma: FakePrisma, csv: string | Buffer) {
  const media = { readBuffer: jest.fn().mockResolvedValue(Buffer.isBuffer(csv) ? csv : Buffer.from(csv, "utf8")), ingestDocument: jest.fn(), remove: jest.fn().mockResolvedValue({ ok: true }) };
  const tags = { assign: jest.fn().mockResolvedValue({ contactsUpdated: 0 }) };
  const bulk = { run: jest.fn().mockResolvedValue({ affected: 0 }) };
  const outbound = { emitSegmentUpserted: jest.fn() };
  const notifications = { notify: jest.fn().mockResolvedValue(1) };
  const runner = new ImportRunnerService(
    prisma as never,
    media as never,
    tags as never,
    bulk as never,
    outbound as never,
    notifications as never,
  );
  return { runner, media, tags, bulk, outbound, notifications };
}

export function makeService(prisma: FakePrisma, csv: string | Buffer, can: (perm: string) => boolean = () => true) {
  const made = makeRunner(prisma, csv);
  const perm = { viewerCan: jest.fn(async (_ws: string, _v: unknown, p: string) => can(p)) };
  const svc = new ImportsService(prisma as never, made.media as never, perm as never, made.runner);
  return { svc, perm, ...made };
}
