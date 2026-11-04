import { Injectable, NotFoundException, Optional } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { PrismaService } from "../prisma/prisma.service";
import { WORKFLOW_TRIGGER_EVENT, WorkflowTriggerEvent } from "../workflows/workflow-events";
import { HjzAppointmentSyncService } from "../hjz-sync/hjz-appointment-sync.service";
import { CreateAppointmentDto, UpdateAppointmentDto } from "./appointments.dto";

@Injectable()
export class AppointmentsService {
  constructor(
    private readonly prisma: PrismaService,
    // Connected to HJZ → every booking change is mirrored there (no-op otherwise).
    @Optional() private readonly hjzSync?: HjzAppointmentSyncService,
    @Optional() private readonly events?: EventEmitter2,
  ) {}

  list(workspaceId: string, opts: { from?: string; to?: string; status?: string; limit?: number } = {}) {
    return this.prisma.appointment.findMany({
      where: {
        workspaceId,
        startAt:
          opts.from || opts.to
            ? { gte: opts.from ? new Date(opts.from) : undefined, lte: opts.to ? new Date(opts.to) : undefined }
            : undefined,
        status: opts.status,
      },
      orderBy: { startAt: "asc" },
      take: opts.limit,
    });
  }

  async get(workspaceId: string, id: string) {
    const row = await this.prisma.appointment.findFirst({
      where: { id, workspaceId },
    });
    if (!row) throw new NotFoundException("Appointment not found");
    return row;
  }

  async create(workspaceId: string, dto: CreateAppointmentDto) {
    const row = await this.prisma.appointment.create({
      data: { ...dto, workspaceId, startAt: new Date(dto.startAt) },
    });
    void this.hjzSync?.changed(row.id);
    return row;
  }

  async update(workspaceId: string, id: string, dto: UpdateAppointmentDto) {
    const existing = await this.get(workspaceId, id);
    const updated = await this.prisma.appointment.update({
      where: { id },
      data: {
        ...dto,
        startAt: dto.startAt ? new Date(dto.startAt) : undefined,
      },
      include: { contact: { select: { id: true, name: true, phone: true } } },
    });
    const { contact, ...row } = updated;
    void this.hjzSync?.changed(row.id);
    // Only the transition into "completed" counts, so editing a finished
    // booking never re-sends a thank-you.
    if (existing.status !== "completed" && row.status === "completed") {
      this.events?.emit(WORKFLOW_TRIGGER_EVENT, {
        workspaceId,
        triggerType: "appointment_completed",
        payload: {
          appointment: {
            id: row.id,
            contactId: row.contactId,
            service: row.service,
            serviceAr: row.serviceAr,
            startAt: row.startAt.toISOString(),
            durationMin: row.durationMin,
          },
          contact,
        },
      } satisfies WorkflowTriggerEvent);
    }
    return row;
  }

  async remove(workspaceId: string, id: string) {
    const existing = await this.get(workspaceId, id);
    await this.hjzSync?.deleted(existing);
    await this.prisma.appointment.delete({ where: { id } });
    return { ok: true };
  }
}
