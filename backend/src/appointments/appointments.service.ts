import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreateAppointmentDto, UpdateAppointmentDto } from "./appointments.dto";

@Injectable()
export class AppointmentsService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.appointment.findMany({ orderBy: { startAt: "asc" } });
  }

  async get(id: string) {
    const row = await this.prisma.appointment.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("Appointment not found");
    return row;
  }

  create(dto: CreateAppointmentDto) {
    return this.prisma.appointment.create({
      data: { ...dto, startAt: new Date(dto.startAt) },
    });
  }

  async update(id: string, dto: UpdateAppointmentDto) {
    await this.get(id);
    return this.prisma.appointment.update({
      where: { id },
      data: {
        ...dto,
        startAt: dto.startAt ? new Date(dto.startAt) : undefined,
      },
    });
  }

  async remove(id: string) {
    await this.get(id);
    await this.prisma.appointment.delete({ where: { id } });
    return { ok: true };
  }
}
