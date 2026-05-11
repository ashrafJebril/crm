import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreateAppointmentDto, UpdateAppointmentDto } from "./appointments.dto";

@Injectable()
export class AppointmentsService {
  constructor(private readonly prisma: PrismaService) {}

  list(workspaceId: string) {
    return this.prisma.appointment.findMany({
      where: { workspaceId },
      orderBy: { startAt: "asc" },
    });
  }

  async get(workspaceId: string, id: string) {
    const row = await this.prisma.appointment.findFirst({
      where: { id, workspaceId },
    });
    if (!row) throw new NotFoundException("Appointment not found");
    return row;
  }

  create(workspaceId: string, dto: CreateAppointmentDto) {
    return this.prisma.appointment.create({
      data: { ...dto, workspaceId, startAt: new Date(dto.startAt) },
    });
  }

  async update(workspaceId: string, id: string, dto: UpdateAppointmentDto) {
    await this.get(workspaceId, id);
    return this.prisma.appointment.update({
      where: { id },
      data: {
        ...dto,
        startAt: dto.startAt ? new Date(dto.startAt) : undefined,
      },
    });
  }

  async remove(workspaceId: string, id: string) {
    await this.get(workspaceId, id);
    await this.prisma.appointment.delete({ where: { id } });
    return { ok: true };
  }
}
