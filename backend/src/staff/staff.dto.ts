import { Allow, IsArray, IsBoolean, IsInt, IsOptional, IsString } from "class-validator";
import type { WeeklySchedule } from "../bookings/schedule";

export { ListCatalogQuery } from "../services/services.dto";

/**
 * SP-10 staff DTOs. Field rules (names, colour, schedule) run in the service
 * (`bookings/catalog-fields.ts`, `bookings/schedule.ts`) so every caller gets
 * the same `bookings.*` keys; these classes whitelist the shape.
 */

/** The wire shape (Global Constraints → DTOs). */
export interface StaffResourceDto {
  id: string;
  userId: string | null;
  user: { id: string; name: string } | null;
  name: string;
  nameAr: string | null;
  role: string | null;
  color: string;
  schedule: WeeklySchedule;
  scheduleConfigured: boolean;
  active: boolean;
  archivedAt: Date | null;
  version: number;
  serviceIds: string[];
  upcomingCount: number;
}

export class CreateStaffDto {
  @Allow() name?: string;
  @IsOptional() @Allow() nameAr?: string | null;
  @IsOptional() @Allow() role?: string | null;
  @IsOptional() @Allow() color?: string;
  /** A workspace member (400 `bookings.not_a_member`); one resource per member (409 `bookings.member_has_resource`). */
  @IsOptional() @Allow() userId?: string | null;
  /** WeeklySchedule; malformed → 400 `bookings.schedule_invalid {day, index, reason}`. */
  @IsOptional() @Allow() schedule?: unknown;
  @IsOptional() @IsArray() @IsString({ each: true }) serviceIds?: string[];
}

export class UpdateStaffDto {
  @IsOptional() @Allow() name?: string;
  @IsOptional() @Allow() nameAr?: string | null;
  @IsOptional() @Allow() role?: string | null;
  @IsOptional() @Allow() color?: string;
  /** null unlinks the member. */
  @IsOptional() @Allow() userId?: string | null;
  @IsOptional() @Allow() schedule?: unknown;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsInt() version?: number;
}

export class SetStaffServicesDto {
  @IsArray() @IsString({ each: true }) serviceIds!: string[];
}
