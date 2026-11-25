/**
 * SP-10 catalog field rules shared by services and staff (and the catalog
 * import's review step). Each parser returns the clean value or throws the
 * booking error key. Pure.
 */
import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  BOOKING_COLORS,
  CURRENCY_PATTERN,
  MAX_NAME_LENGTH,
  MAX_ROLE_LENGTH,
  PRICE_PATTERN,
  SERVICE_DURATION_MAX,
  SERVICE_DURATION_MIN,
} from "./booking-constants";
import { bookingError } from "./booking-errors";

/** Bookings that hold a slot (and count as "upcoming" when in the future). */
export const BLOCKING_STATUSES = ["pending", "confirmed"] as const;

const clean = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");

/** A required display name (≤ MAX_NAME_LENGTH). */
export function parseName(v: unknown): string {
  const s = clean(v);
  if (!s || s.length > MAX_NAME_LENGTH) throw bookingError("bookings.name_required", { max: MAX_NAME_LENGTH });
  return s;
}

/** An optional name: empty → null. */
export function parseOptionalName(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = clean(v);
  if (!s) return null;
  if (s.length > MAX_NAME_LENGTH) throw bookingError("bookings.name_required", { max: MAX_NAME_LENGTH });
  return s;
}

export function parseRole(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = clean(v);
  if (!s) return null;
  if (s.length > MAX_ROLE_LENGTH) throw bookingError("bookings.name_required", { max: MAX_ROLE_LENGTH });
  return s;
}

export function parseDuration(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < SERVICE_DURATION_MIN || v > SERVICE_DURATION_MAX) {
    throw bookingError("bookings.duration_invalid", { min: SERVICE_DURATION_MIN, max: SERVICE_DURATION_MAX });
  }
  return v;
}

/** A price as a DECIMAL(12,2) string, or null. Numbers are accepted when exact. */
export function parsePrice(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const s = typeof v === "number" && Number.isFinite(v) ? String(v) : typeof v === "string" ? v.trim() : "";
  if (!PRICE_PATTERN.test(s)) throw bookingError("bookings.price_invalid");
  return new Prisma.Decimal(s).toFixed(2);
}

export function parseCurrency(v: unknown): string {
  const s = typeof v === "string" ? v.trim().toUpperCase() : "";
  if (!CURRENCY_PATTERN.test(s)) throw bookingError("bookings.currency_invalid");
  return s;
}

export function parseColor(v: unknown): string {
  if (typeof v !== "string" || !(BOOKING_COLORS as readonly string[]).includes(v)) {
    throw bookingError("bookings.color_invalid", { allowed: [...BOOKING_COLORS] });
  }
  return v;
}

/** A stored price (Prisma.Decimal, string or number) as a 2-decimal string. */
export function priceOut(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return new Prisma.Decimal(v as Prisma.Decimal.Value).toFixed(2);
}

/** Unique, non-empty string ids. */
export function parseIds(v: unknown, field: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x)) {
    throw new BadRequestException(`${field} must be an array of ids`);
  }
  return [...new Set(v as string[])];
}
