import { Type } from "class-transformer";
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateIf,
} from "class-validator";
import { SERVICE_DURATION_MAX } from "../bookings/booking-constants";

const STATUSES = ["confirmed", "pending", "completed", "cancelled", "no-show"] as const;
const SOURCES = ["human", "self-booking"] as const;
const SERVICE_REQUIRED = { message: "bookings.service_required" };

export class CreateAppointmentDto {
  @IsString() @IsNotEmpty() contactId!: string;
  /** SP-10: a catalog service. When set, service/serviceAr/durationMin default to it. */
  @IsOptional() @IsString() @IsNotEmpty() serviceId?: string;
  /** SP-10: a staff resource. Without it, a staffId whose member has a resource uses that one (ruling 4). */
  @IsOptional() @IsString() @IsNotEmpty() resourceId?: string;
  @ValidateIf((o) => !o.serviceId || o.service !== undefined) @IsString(SERVICE_REQUIRED) @IsNotEmpty(SERVICE_REQUIRED) service?: string;
  @ValidateIf((o) => !o.serviceId || o.serviceAr !== undefined) @IsString(SERVICE_REQUIRED) @IsNotEmpty(SERVICE_REQUIRED) serviceAr?: string;
  @IsDateString() startAt!: string;
  @ValidateIf((o) => !o.serviceId || o.durationMin !== undefined) @IsInt() @Min(1) @Max(SERVICE_DURATION_MAX) durationMin?: number;
  @IsIn([...STATUSES]) status!: (typeof STATUSES)[number];
  @IsIn([...SOURCES]) source!: (typeof SOURCES)[number];
  @IsOptional() @IsString() staffId?: string;
  @IsOptional() @IsString() note?: string;
  @IsOptional() @IsString() noteAr?: string;
  @IsOptional() @IsBoolean() reminderSent?: boolean;
}

export class UpdateAppointmentDto {
  @IsOptional() @IsString() service?: string;
  @IsOptional() @IsString() serviceAr?: string;
  @IsOptional() @IsDateString() startAt?: string;
  @IsOptional() @IsInt() @Min(1) @Max(SERVICE_DURATION_MAX) durationMin?: number;
  @IsOptional() @IsIn([...STATUSES]) status?: (typeof STATUSES)[number];
  @IsOptional() @IsIn([...SOURCES]) source?: (typeof SOURCES)[number];
  @IsOptional() @IsString() staffId?: string;
  @IsOptional() @IsString() note?: string;
  @IsOptional() @IsString() noteAr?: string;
  @IsOptional() @IsBoolean() reminderSent?: boolean;
  /** SP-10: null unlinks the catalog service (the name snapshot stays). */
  @IsOptional() @IsString() serviceId?: string | null;
  /** SP-10: null unlinks the resource. */
  @IsOptional() @IsString() resourceId?: string | null;
  /** SP-10: the version the client read; a mismatch is 409 bookings.version_conflict {current}. */
  @IsOptional() @IsInt() version?: number;
}

export class ListAppointmentsQuery {
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  /** One status or several, comma-separated. */
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() serviceId?: string;
  @IsOptional() @IsString() resourceId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
}

export class SearchAppointmentsQuery {
  @IsOptional() @IsString() q?: string;
}
