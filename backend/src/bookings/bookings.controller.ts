import { Controller, Get, Query } from "@nestjs/common";
import { Type } from "class-transformer";
import { IsInt, IsNotEmpty, IsOptional, IsString } from "class-validator";
import { CurrentWorkspace } from "../common/current-workspace.decorator";
import { BookingsService } from "./bookings.service";

export class AvailabilityQuery {
  @IsString() @IsNotEmpty() serviceId!: string;
  @IsOptional() @IsString() resourceId?: string;
  /** YYYY-MM-DD in the workspace timezone. */
  @IsString() date!: string;
  /** Reschedule: the booking being moved does not block its own slots (same workspace, else 404). */
  @IsOptional() @IsString() @IsNotEmpty() excludeAppointmentId?: string;
  /** Reschedule: slots for the booking's own duration (5..1440), not the service's. */
  @IsOptional() @Type(() => Number) @IsInt() durationMin?: number;
}

/** SP-10: `GET /bookings/availability` (bookings.view in permission-map.ts). */
@Controller("bookings")
export class BookingsController {
  constructor(private readonly svc: BookingsService) {}

  @Get("availability")
  availability(@CurrentWorkspace() workspaceId: string, @Query() q: AvailabilityQuery) {
    return this.svc.availability(workspaceId, q);
  }
}
