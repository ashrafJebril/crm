import { Injectable, NotFoundException, Optional } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { HjzAppointmentSyncService } from "../hjz-sync/hjz-appointment-sync.service";
import { CreateAppointmentDto, UpdateAppointmentDto } from "./appointments.dto";

@Injectable()
export class AppointmentsService {
  constructor(
    private readonly prisma: PrismaService,
    // Connected to HJZ → every booking change is mirrored there (no-op otherwise).
    @Optional() private readonly hjzSync?: HjzAppointmentSyncService,
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
    await this.get(workspaceId, id);
    const row = await this.prisma.appointment.update({
      where: { id },
      data: {
        ...dto,
        startAt: dto.startAt ? new Date(dto.startAt) : undefined,
      },
    });
    void this.hjzSync?.changed(row.id);
    return row;
  }

  async remove(workspaceId: string, id: string) {
    const existing = await this.get(workspaceId, id);
    await this.hjzSync?.deleted(existing);
    await this.prisma.appointment.delete({ where: { id } });
    return { ok: true };
  }
}
