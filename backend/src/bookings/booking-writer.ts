/**
 * SP-10 booking writer (Architecture → Writes). The single path for every
 * booking create and update: REST (`AppointmentsService`), the MCP agent
 * tools, and future internal callers (`bypassFit`, ruling 5).
 *
 *  1. Resolve the service and resource by (id, workspaceId); unknown/foreign
 *     → 404; archived/paused → 400.
 *  2. Ruling 4: no resourceId but a staffId whose member has an active
 *     resource → that resource is used (and gated).
 *  3. Snapshot: durationMin, service/serviceAr default to the service's;
 *     staffId = the resource's member when it has one. The HJZ payload reads
 *     only these columns, so it is unchanged.
 *  4. Fit gate (a resolved resource, an open status, not bypassFit): not ok
 *     → 422 `bookings.outside_schedule {fit}`.
 *  5. One transaction: lock service then resource (`booking-locks.ts`),
 *     re-read both (archived → 400), re-check overlap with open bookings of
 *     the resource and its member → 409 `SLOT_TAKEN {conflict}`, then write.
 *     Updates compare-and-set `version` when the caller sent one (→ 409
 *     `bookings.version_conflict {current}`) and always increment it.
 *  6. After commit: `hjzSync.changed(id)`, and the `appointment_completed`
 *     workflow event on a transition into `completed` (both as before).
 *
 * Updates: the transition table applies to status changes (same status is a
 * no-op); time/duration/resource changes need an open booking (409
 * `bookings.closed`); a change that does not move time, duration or resource
 * is never re-gated (so HJZ-linked rows and status changes are not).
 */
import { NotFoundException } from "@nestjs/common";
import type { Appointment, Prisma, Service, StaffResource } from "@prisma/client";
import type { EventEmitter2 } from "@nestjs/event-emitter";
import type { PrismaService } from "../prisma/prisma.service";
import type { HjzAppointmentSyncService } from "../hjz-sync/hjz-appointment-sync.service";
import { WORKFLOW_TRIGGER_EVENT, type WorkflowTriggerEvent } from "../workflows/workflow-events";
import { bookingError } from "./booking-errors";
import { SERVICE_DURATION_MAX } from "./booking-constants";
import { lockResource, lockService } from "./booking-locks";
import { assertTransition, isOpenStatus } from "./booking-status";
import { blockingBookings, BookingsService } from "./bookings.service";
import { readSchedule, scheduleFitAt } from "./schedule";

export interface BookingCreateInput {
  contactId: string;
  serviceId?: string | null;
  resourceId?: string | null;
  staffId?: string | null;
  service?: string;
  serviceAr?: string;
  startAt: string | Date;
  durationMin?: number;
  status: string;
  source: string;
  note?: string | null;
  noteAr?: string | null;
  reminderSent?: boolean;
}

export type BookingUpdateInput = Partial<Omit<BookingCreateInput, "contactId">> & { version?: number };

export interface WriteOpts {
  /** Internal callers only (a future HJZ inbound, SP-23 connectors): skip fit and overlap. */
  bypassFit?: boolean;
}

/** A decision was made on data that changed before the conditional write: decide again. */
class StaleRead extends Error {}
const UPDATE_ATTEMPTS = 3;

const sameTime = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null);

/** The fields an update's decisions depend on. */
function sameDecisionFields(a: Appointment, b: Appointment): boolean {
  return (
    a.status === b.status &&
    sameTime(a.startAt, b.startAt) &&
    a.durationMin === b.durationMin &&
    a.resourceId === b.resourceId &&
    a.staffId === b.staffId &&
    a.serviceId === b.serviceId &&
    a.version === b.version
  );
}

/**
 * Every caller (REST, MCP, internal): ids are never empty strings (review C1,
 * never a FK 500) and durations stay within 1..SERVICE_DURATION_MAX, which the
 * overlap look-back relies on (review I3).
 */
function assertInputShape(input: { serviceId?: string | null; resourceId?: string | null; durationMin?: number }) {
  if (input.serviceId === "") throw bookingError("bookings.service_not_found");
  if (input.resourceId === "") throw bookingError("bookings.resource_not_found");
  const d = input.durationMin;
  if (d !== undefined && (typeof d !== "number" || !Number.isInteger(d) || d < 1 || d > SERVICE_DURATION_MAX)) {
    throw bookingError("bookings.duration_invalid", { min: 1, max: SERVICE_DURATION_MAX });
  }
}

// The interactive-transaction client of the tenancy-extended PrismaService.
type Tx = Pick<PrismaService, "appointment" | "service" | "staffResource" | "$executeRaw">;

export class BookingWriter {
  private readonly read: BookingsService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly hjzSync?: HjzAppointmentSyncService,
    private readonly events?: EventEmitter2,
  ) {
    this.read = new BookingsService(prisma);
  }

  async create(workspaceId: string, input: BookingCreateInput, opts: WriteOpts = {}) {
    assertInputShape(input);
    const contact = await this.prisma.contact.findFirst({ where: { id: input.contactId, workspaceId }, select: { id: true } });
    if (!contact) throw new NotFoundException("Contact not found");

    const service = input.serviceId ? await this.findService(workspaceId, input.serviceId) : null;
    if (!service && (!input.service || !input.serviceAr || !input.durationMin)) throw bookingError("bookings.service_required");
    const resource = await this.resolveResource(workspaceId, input.resourceId, input.staffId);
    if (service && resource && input.resourceId) await this.assertOffers(workspaceId, resource.id, service.id);

    const startAt = new Date(input.startAt);
    const durationMin = input.durationMin ?? (service as Service).durationMin;
    const data: Prisma.AppointmentUncheckedCreateInput = {
      workspaceId,
      contactId: input.contactId,
      service: input.service ?? (service as Service).name,
      serviceAr: input.serviceAr ?? (service as Service).nameAr,
      startAt,
      durationMin,
      status: input.status,
      source: input.source,
      staffId: resource?.userId ?? input.staffId ?? null,
      serviceId: service?.id ?? null,
      resourceId: resource?.id ?? null,
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.noteAr !== undefined ? { noteAr: input.noteAr } : {}),
      ...(input.reminderSent !== undefined ? { reminderSent: input.reminderSent } : {}),
    };
    const gate = !!resource && !opts.bypassFit && isOpenStatus(input.status);
    if (gate) await this.assertFit(workspaceId, resource as StaffResource, startAt, durationMin);

    const row = await this.inTx(service?.id ?? null, resource?.id ?? null, async (tx) => {
      if (service) await this.recheckService(tx, workspaceId, service.id);
      if (resource) await this.recheckResource(tx, workspaceId, resource.id);
      if (gate) await this.assertFree(tx, workspaceId, resource as StaffResource, startAt, durationMin);
      return tx.appointment.create({ data });
    });
    void this.hjzSync?.changed(row.id);
    const [out] = await this.read.annotate(workspaceId, [row]);
    return out;
  }

  /**
   * Review C2: every decision (transition, closed, R4, gate, version) is made
   * on a read, re-checked under the locks inside the transaction, and the
   * write is conditional on the fields it was decided on. If anything moved
   * meanwhile (another writer, `main`, a stale read), the update is decided
   * again from a fresh read, up to UPDATE_ATTEMPTS times.
   */
  async update(workspaceId: string, id: string, input: BookingUpdateInput, opts: WriteOpts = {}) {
    assertInputShape(input);
    for (let attempt = 0; attempt < UPDATE_ATTEMPTS; attempt++) {
      const existing = await this.prisma.appointment.findFirst({ where: { id, workspaceId } });
      if (!existing) throw new NotFoundException("Appointment not found");
      try {
        return await this.updateFrom(workspaceId, existing, input, opts);
      } catch (e) {
        if (e instanceof StaleRead) continue;
        throw e;
      }
    }
    const current = await this.prisma.appointment.findFirst({ where: { id, workspaceId } });
    if (!current) throw new NotFoundException("Appointment not found");
    throw await this.conflict(workspaceId, current);
  }

  private async updateFrom(workspaceId: string, existing: Appointment, input: BookingUpdateInput, opts: WriteOpts) {
    const id = existing.id;
    if (input.version !== undefined && input.version !== existing.version) throw await this.conflict(workspaceId, existing);

    const status = input.status ?? existing.status;
    if (input.status !== undefined) assertTransition(existing.status, input.status);

    // Service: a new catalog service re-snapshots names and duration unless given.
    let service: Service | null = null;
    const serviceChanged = input.serviceId !== undefined && (input.serviceId ?? null) !== existing.serviceId;
    if (serviceChanged && input.serviceId) service = await this.findService(workspaceId, input.serviceId);

    const startAt = input.startAt !== undefined ? new Date(input.startAt) : existing.startAt;
    const durationMin = input.durationMin ?? (service ? service.durationMin : existing.durationMin);
    const timeChanged = startAt.getTime() !== existing.startAt.getTime() || durationMin !== existing.durationMin;
    const staffChanged = input.staffId !== undefined && (input.staffId ?? null) !== existing.staffId;
    const finalStaff = staffChanged ? input.staffId ?? null : existing.staffId;

    // Resource: an explicit id; else (ruling 4) the member's resource whenever
    // the row would end up without one (explicit unlink, staff change, or a
    // move of a legacy row) — so no write leaves an ungated row that still
    // blocks the member's resource (review C1); else the row's own.
    let resource: StaffResource | null = null;
    if (input.resourceId) {
      resource = await this.resolveResource(workspaceId, input.resourceId, null);
    } else if (input.resourceId === null || staffChanged || (timeChanged && !existing.resourceId)) {
      resource = await this.resolveResource(workspaceId, null, finalStaff);
    } else if (existing.resourceId) {
      resource = await this.prisma.staffResource.findFirst({ where: { id: existing.resourceId, workspaceId } });
    }
    const resourceChanged = (resource?.id ?? null) !== existing.resourceId || staffChanged;
    if ((timeChanged || resourceChanged) && !isOpenStatus(existing.status)) throw bookingError("bookings.closed", { status: existing.status });

    const targetServiceId = serviceChanged ? (input.serviceId ?? null) : existing.serviceId;
    if (resource && input.resourceId && targetServiceId && (resourceChanged || serviceChanged)) {
      await this.assertOffers(workspaceId, resource.id, targetServiceId);
    }

    const data: Prisma.AppointmentUncheckedUpdateManyInput = {
      ...(input.service !== undefined ? { service: input.service } : service ? { service: service.name } : {}),
      ...(input.serviceAr !== undefined ? { serviceAr: input.serviceAr } : service ? { serviceAr: service.nameAr } : {}),
      ...(input.startAt !== undefined ? { startAt } : {}),
      ...(durationMin !== existing.durationMin ? { durationMin } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.noteAr !== undefined ? { noteAr: input.noteAr } : {}),
      ...(input.reminderSent !== undefined ? { reminderSent: input.reminderSent } : {}),
      ...(serviceChanged ? { serviceId: input.serviceId ?? null } : {}),
      version: { increment: 1 },
    };
    const moved = timeChanged || resourceChanged;
    if (moved || input.resourceId !== undefined) {
      data.resourceId = resource?.id ?? null;
      data.staffId = resource?.userId ?? finalStaff;
    } else if (staffChanged) {
      data.staffId = finalStaff;
    }

    const gate = !!resource && moved && !opts.bypassFit && isOpenStatus(status);
    if (gate) await this.assertFit(workspaceId, resource as StaffResource, startAt, durationMin);

    const lockSvc = serviceChanged && input.serviceId ? input.serviceId : null;
    const lockRes = resource && (gate || resourceChanged) ? resource.id : null;
    const row = await this.inTx(lockSvc, lockRes, async (tx) => {
      // Under the locks: the row must still be what we decided on.
      const fresh = await tx.appointment.findFirst({ where: { id, workspaceId } });
      if (!fresh) throw new NotFoundException("Appointment not found");
      if (!sameDecisionFields(fresh, existing)) throw new StaleRead();
      if (lockSvc) await this.recheckService(tx, workspaceId, lockSvc);
      if (lockRes) await this.recheckResource(tx, workspaceId, lockRes);
      if (gate) await this.assertFree(tx, workspaceId, resource as StaffResource, startAt, durationMin, id);
      // Conditional on every field the decision used (main's writes do not bump version).
      const { count } = await tx.appointment.updateMany({
        where: {
          id,
          workspaceId,
          status: existing.status,
          startAt: existing.startAt,
          durationMin: existing.durationMin,
          resourceId: existing.resourceId,
          staffId: existing.staffId,
          serviceId: existing.serviceId,
          version: existing.version,
        },
        data,
      });
      if (count === 0) {
        const current = await tx.appointment.findFirst({ where: { id, workspaceId } });
        if (!current) throw new NotFoundException("Appointment not found");
        if (input.version !== undefined && current.version !== input.version) throw await this.conflict(workspaceId, current);
        throw new StaleRead();
      }
      return tx.appointment.findFirst({
        where: { id, workspaceId },
        include: { contact: { select: { id: true, name: true, phone: true } } },
      });
    });
    const { contact, ...plain } = row as Appointment & { contact: { id: string; name: string; phone: string | null } };
    void this.hjzSync?.changed(plain.id);
    // Only the transition into "completed" counts, so editing a finished
    // booking never re-sends a thank-you.
    if (existing.status !== "completed" && plain.status === "completed") {
      this.events?.emit(WORKFLOW_TRIGGER_EVENT, {
        workspaceId,
        triggerType: "appointment_completed",
        payload: {
          appointment: {
            id: plain.id,
            contactId: plain.contactId,
            service: plain.service,
            serviceAr: plain.serviceAr,
            startAt: plain.startAt.toISOString(),
            durationMin: plain.durationMin,
          },
          contact,
        },
      } satisfies WorkflowTriggerEvent);
    }
    const [out] = await this.read.annotate(workspaceId, [plain as Appointment]);
    return out;
  }

  // ── steps ────────────────────────────────────────────────────────────

  private async inTx<T>(serviceId: string | null, resourceId: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      // Lock order: service, then resource (booking-locks.ts).
      if (serviceId) await lockService(tx, serviceId);
      if (resourceId) await lockResource(tx, resourceId);
      return fn(tx);
    });
  }

  private async findService(workspaceId: string, id: string): Promise<Service> {
    const s = await this.prisma.service.findFirst({ where: { id, workspaceId } });
    if (!s) throw bookingError("bookings.service_not_found");
    if (s.archivedAt || !s.active) throw bookingError("bookings.service_archived");
    return s;
  }

  /** Explicit resource (404/archived), else the staff member's active resource (ruling 4), else none. */
  private async resolveResource(workspaceId: string, resourceId: string | null | undefined, staffId: string | null | undefined) {
    if (resourceId) {
      const r = await this.prisma.staffResource.findFirst({ where: { id: resourceId, workspaceId } });
      if (!r) throw bookingError("bookings.resource_not_found");
      if (r.archivedAt || !r.active) throw bookingError("bookings.resource_archived");
      return r;
    }
    if (!staffId) return null;
    return this.prisma.staffResource.findFirst({ where: { workspaceId, userId: staffId, active: true, archivedAt: null } });
  }

  private async assertOffers(workspaceId: string, resourceId: string, serviceId: string) {
    const link = await this.prisma.staffService.findFirst({ where: { workspaceId, resourceId, serviceId } });
    if (!link) throw bookingError("bookings.resource_not_offering");
  }

  private async assertFit(workspaceId: string, resource: StaffResource, startAt: Date, durationMin: number) {
    const tz = await this.read.workspaceTz(workspaceId);
    const fit = scheduleFitAt(readSchedule(resource.schedule), startAt, durationMin, tz);
    if (fit.kind !== "ok") throw bookingError("bookings.outside_schedule", { fit });
  }

  /** Under the locks: a catalog row archived meanwhile is refused (Task 1 delete contract). */
  private async recheckService(tx: Tx, workspaceId: string, id: string) {
    const s = await tx.service.findFirst({ where: { id, workspaceId }, select: { active: true, archivedAt: true } });
    if (!s) throw bookingError("bookings.service_not_found");
    if (s.archivedAt || !s.active) throw bookingError("bookings.service_archived");
  }

  private async recheckResource(tx: Tx, workspaceId: string, id: string) {
    const r = await tx.staffResource.findFirst({ where: { id, workspaceId }, select: { active: true, archivedAt: true } });
    if (!r) throw bookingError("bookings.resource_not_found");
    if (r.archivedAt || !r.active) throw bookingError("bookings.resource_archived");
  }

  private async assertFree(tx: Tx, workspaceId: string, resource: StaffResource, startAt: Date, durationMin: number, excludeId?: string) {
    const end = new Date(startAt.getTime() + durationMin * 60_000);
    const [hit] = await blockingBookings(tx, workspaceId, [resource], startAt, end, excludeId);
    if (hit) {
      throw bookingError("SLOT_TAKEN", {
        conflict: { id: hit.id, startAt: hit.startAt, durationMin: hit.durationMin, status: hit.status },
      });
    }
  }

  private async conflict(workspaceId: string, row: Appointment) {
    const [current] = await this.read.annotate(workspaceId, [row]);
    return bookingError("bookings.version_conflict", { current });
  }
}
