import { Controller, Get, Query } from "@nestjs/common";
import { IsNotEmpty, IsOptional, IsString } from "class-validator";
import { CurrentWorkspace } from "../common/current-workspace.decorator";
import { BookingsService } from "./bookings.service";

export class AvailabilityQuery {
  @IsString() @IsNotEmpty() serviceId!: string;
  @IsOptional() @IsString() resourceId?: string;
  /** YYYY-MM-DD in the workspace timezone. */
  @IsString() date!: string;
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
