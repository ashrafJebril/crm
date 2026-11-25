/** In-memory prisma fake for the activities specs. Understands scalar equality,
 *  null, {in,not,lt,lte,gt,gte}, AND and OR; nested relation filters are
 *  treated as matching (specs assert those through the recorded `where`). */
type Row = Record<string, any>;

function matchValue(v: any, cond: any): boolean {
  if (cond === null) return v === null || v === undefined;
  if (cond instanceof Date) return v instanceof Date && v.getTime() === cond.getTime();
  if (typeof cond === "object" && !Array.isArray(cond)) {
    for (const [op, c] of Object.entries<any>(cond)) {
      const t = (x: any) => (x instanceof Date ? x.getTime() : x);
      if (op === "in") { if (!c.includes(v)) return false; }
      else if (op === "not") { if (c === null ? v == null : v === c) return false; }
      else if (op === "lt") { if (v == null || !(t(v) < t(c))) return false; }
      else if (op === "lte") { if (v == null || !(t(v) <= t(c))) return false; }
      else if (op === "gt") { if (v == null || !(t(v) > t(c))) return false; }
      else if (op === "gte") { if (v == null || !(t(v) >= t(c))) return false; }
    }
    return true;
  }
  return v === cond;
}

export function matches(row: Row, where: Row = {}): boolean {
  for (const [k, cond] of Object.entries<any>(where)) {
    if (k === "AND") { if (!(Array.isArray(cond) ? cond : [cond]).every((w) => matches(row, w))) return false; continue; }
    if (k === "OR") { if (!cond.some((w: Row) => matches(row, w))) return false; continue; }
    if (["contact", "ticket", "booking", "assignee"].includes(k)) continue;
    if (!matchValue(row[k], cond)) return false;
  }
  return true;
}

export class FakePrisma {
  activities: Row[] = [];
  contacts: Row[] = [{ id: "c1", name: "Ali", workspaceId: "ws" }];
  tickets: Row[] = [{ id: "t1", number: 7, title: "Deal", contactId: "c1", workspaceId: "ws" }];
  bookings: Row[] = [{ id: "b1", workspaceId: "ws" }];
  members: Row[] = [
    { userId: "u1", workspaceId: "ws" },
    { userId: "u2", workspaceId: "ws" },
  ];
  timezone = "Asia/Dubai";
  seq = 0;

  private withInclude(a: Row | null) {
    if (!a) return a;
    const contact = this.contacts.find((c) => c.id === a.contactId);
    const ticket = this.tickets.find((t) => t.id === a.ticketId);
    return {
      ...a,
      contact: contact ? { id: contact.id, name: contact.name } : null,
      ticket: ticket ? { id: ticket.id, number: ticket.number, title: ticket.title } : null,
    };
  }

  activity = {
    create: jest.fn(async ({ data }: any) => {
      const row = { id: `a${++this.seq}`, notes: null, dueAt: null, doneAt: null, outcome: null, notifiedAt: null,
        assigneeId: null, contactId: null, ticketId: null, bookingId: null, createdById: null,
        createdAt: new Date(), updatedAt: new Date(), ...data };
      this.activities.push(row);
      return this.withInclude(row);
    }),
    findFirst: jest.fn(async ({ where }: any) => this.withInclude(this.activities.find((a) => matches(a, where)) ?? null)),
    findMany: jest.fn(async ({ where, take }: any = {}) => {
      const rows = this.activities.filter((a) => matches(a, where));
      return rows.slice(0, take ?? rows.length).map((r) => this.withInclude(r));
    }),
    count: jest.fn(async ({ where }: any = {}) => this.activities.filter((a) => matches(a, where)).length),
    update: jest.fn(async ({ where, data }: any) => {
      const row = this.activities.find((a) => a.id === where.id)!;
      Object.assign(row, data, { updatedAt: new Date() });
      return this.withInclude(row);
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      const rows = this.activities.filter((a) => matches(a, where));
      rows.forEach((r) => Object.assign(r, data));
      return { count: rows.length };
    }),
    delete: jest.fn(async ({ where }: any) => {
      this.activities = this.activities.filter((a) => a.id !== where.id);
      return {};
    }),
  };
  contact = { findFirst: jest.fn(async ({ where }: any) => this.contacts.find((c) => matches(c, where)) ?? null) };
  ticket = { findFirst: jest.fn(async ({ where }: any) => this.tickets.find((c) => matches(c, where)) ?? null) };
  appointment = { findFirst: jest.fn(async ({ where }: any) => this.bookings.find((c) => matches(c, where)) ?? null) };
  workspaceMember = { findFirst: jest.fn(async ({ where }: any) => this.members.find((c) => matches(c, where)) ?? null) };
  workspace = { findUnique: jest.fn(async () => ({ timezone: this.timezone })) };

  seed(over: Row = {}): Row {
    const row = { id: `a${++this.seq}`, workspaceId: "ws", kind: "follow_up", title: "Call back", notes: null,
      dueAt: new Date("2026-11-10T08:00:00Z"), doneAt: null, outcome: null, notifiedAt: null, assigneeId: "u1",
      contactId: "c1", ticketId: null, bookingId: null, createdById: "u1", createdAt: new Date(), updatedAt: new Date(), ...over };
    this.activities.push(row);
    return row;
  }
}
