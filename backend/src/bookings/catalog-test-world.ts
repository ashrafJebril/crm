/**
 * SP-10 spec helper (not a runtime file): two workspaces over the in-memory
 * Prisma double, with members and the catalog services. Shared by the
 * services/staff specs (and Task 2's booking specs).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { makeFakePrisma, withAdvisoryLocks } from "../channels/test-prisma";
import { ServicesService } from "../services/services.service";
import { StaffService } from "../staff/staff.service";

export const A = "wsA";
export const B = "wsB";

export function catalogWorld(opts: { locks?: boolean } = {}) {
  const prisma = makeFakePrisma({
    workspace: [
      { id: A, name: "A", timezone: "Asia/Riyadh" },
      { id: B, name: "B", timezone: "Europe/London" },
    ],
    user: [
      { id: "uOwner", name: "Owner A" },
      { id: "uAgent", name: "Agent A" },
      { id: "uOther", name: "Member of B" },
    ],
    workspaceMember: [
      { id: "m1", workspaceId: A, userId: "uOwner", role: "owner" },
      { id: "m2", workspaceId: A, userId: "uAgent", role: "agent" },
      { id: "m3", workspaceId: B, userId: "uOther", role: "owner" },
    ],
    appointment: [],
    service: [],
    staffResource: [],
    staffService: [],
  });
  const locks = opts.locks ? withAdvisoryLocks(prisma) : null;
  const services = new ServicesService(prisma as any);
  const staff = new StaffService(prisma as any);
  return { prisma, services, staff, locks };
}

let apptSeq = 0;
/** A booking row as the DB holds it (legacy columns + SP-10 columns). */
export function booking(over: Record<string, unknown>): Record<string, any> {
  return {
    id: `appt_${++apptSeq}`,
    workspaceId: A,
    contactId: "c1",
    staffId: null,
    service: "Haircut",
    serviceAr: "قص شعر",
    startAt: new Date(Date.now() + 86_400_000),
    durationMin: 60,
    status: "confirmed",
    source: "human",
    serviceId: null,
    resourceId: null,
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

/** The body of a thrown HttpException (or the error itself). */
export async function failure(p: Promise<unknown>): Promise<{ status: number; body: any }> {
  try {
    await p;
  } catch (e: any) {
    if (typeof e?.getStatus === "function") return { status: e.getStatus(), body: e.getResponse() };
    throw e;
  }
  throw new Error("expected a rejection");
}
