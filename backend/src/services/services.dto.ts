import { Transform } from "class-transformer";
import { Allow, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString } from "class-validator";

/**
 * SP-10 services DTOs. Field rules (name, duration, price, colour, currency)
 * live in `bookings/catalog-fields.ts` and run in the service, so every
 * caller gets the same `bookings.*` keys; these classes only whitelist the
 * shape for the global ValidationPipe.
 */

/** The wire shape (Global Constraints → DTOs). `price` is a decimal string. */
export interface ServiceDto {
  id: string;
  name: string;
  nameAr: string;
  color: string;
  durationMin: number;
  price: string | null;
  currency: string;
  active: boolean;
  archivedAt: Date | null;
  order: number;
  version: number;
  staffIds: string[];
  upcomingCount: number;
}

export class CreateServiceDto {
  @Allow() name?: string;
  @IsOptional() @Allow() nameAr?: string;
  @IsOptional() @Allow() color?: string;
  @Allow() durationMin?: number;
  /** Decimal string ("120.50") or number; null for none. */
  @IsOptional() @Allow() price?: string | number | null;
  @IsOptional() @Allow() currency?: string;
  @IsOptional() @IsInt() order?: number;
  @IsOptional() @IsArray() @IsString({ each: true }) staffIds?: string[];
}

export class UpdateServiceDto {
  @IsOptional() @Allow() name?: string;
  @IsOptional() @Allow() nameAr?: string;
  @IsOptional() @Allow() color?: string;
  @IsOptional() @Allow() durationMin?: number;
  @IsOptional() @Allow() price?: string | number | null;
  @IsOptional() @Allow() currency?: string;
  @IsOptional() @IsInt() order?: number;
  /** Pause/unpause a non-archived service (archive/restore via DELETE/restore). */
  @IsOptional() @IsBoolean() active?: boolean;
  /** The version the client last read; a mismatch is 409 `bookings.version_conflict {current}`. */
  @IsOptional() @IsInt() version?: number;
}

export class SetServiceStaffDto {
  @IsArray() @IsString({ each: true }) staffIds!: string[];
}

export class ListCatalogQuery {
  /** "true": active only; "false": inactive and archived only; absent: all. */
  @IsOptional()
  @Transform(({ value }) => (value === "true" ? true : value === "false" ? false : value))
  @IsIn([true, false])
  active?: boolean;
  @IsOptional() @IsString() q?: string;
}
