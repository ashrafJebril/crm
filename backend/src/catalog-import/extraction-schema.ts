/**
 * SP-10 catalog import: the extraction contract and the review proposal.
 *
 * The model's output is untrusted data. It is parsed with a strict `zod`
 * schema (unknown keys refused), counts are capped (MAX_PROPOSED_SERVICES /
 * MAX_PROPOSED_STAFF), strings are trimmed and capped, and nothing in it is
 * ever executed or followed — it only becomes proposed rows the user reviews.
 * A duration or working hours the source did not state stay absent; the
 * review fills a visible default duration of 60 (`durationDefaulted: true`).
 */
import { z } from "zod";
import {
  MAX_NAME_LENGTH,
  MAX_PROPOSED_SERVICES,
  MAX_PROPOSED_STAFF,
  MAX_ROLE_LENGTH,
} from "../bookings/booking-constants";
import {
  parseColor,
  parseCurrency,
  parseDuration,
  parseName,
  parseOptionalName,
  parsePrice,
  parseRole,
} from "../bookings/catalog-fields";
import { normalizeName } from "../bookings/names";
import { validateSchedule, type WeeklySchedule } from "../bookings/schedule";
import { WEEKDAYS } from "../bookings/booking-time";

export const DEFAULT_DURATION_MIN = 60;
const MAX_TEXT = 1000;

const day = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

export const extractionSchema = z
  .object({
    lang: z.enum(["en", "ar", "mixed"]),
    services: z
      .array(
        z
          .object({
            title: z.string(),
            titleAr: z.string().optional(),
            description: z.string().optional(),
            priceAmount: z.number().optional(),
            currency: z.string().optional(),
            durationMinutes: z.number().int().optional(),
          })
          .strict(),
      )
      .max(1000),
    staff: z
      .array(
        z
          .object({
            title: z.string(),
            role: z.string().optional(),
            workingHours: z.array(z.object({ day, from: z.string(), to: z.string() }).strict()).max(100).optional(),
          })
          .strict(),
      )
      .max(1000),
  })
  .strict();

export type Extraction = z.infer<typeof extractionSchema>;

/**
 * The same contract as JSON Schema, for the API's structured output
 * (`output_config.format`). Optional fields are left out of `required`; no
 * numeric/length constraints (not supported there) — `zod` enforces the rest.
 */
export const EXTRACTION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["lang", "services", "staff"],
  properties: {
    lang: { type: "string", enum: ["en", "ar", "mixed"] },
    services: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title"],
        properties: {
          title: { type: "string", description: "The service name exactly as written in the source." },
          titleAr: { type: "string", description: "The Arabic name, only when the source gives one." },
          description: { type: "string" },
          priceAmount: { type: "number", description: "Only when the source states a price." },
          currency: { type: "string", description: "ISO 4217 code, only when the source states or clearly implies it." },
          durationMinutes: {
            type: "integer",
            description: "ONLY when the source states a duration. Never estimated.",
          },
        },
      },
    },
    staff: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title"],
        properties: {
          title: { type: "string", description: "The person's (or chair's / room's) name." },
          role: { type: "string" },
          workingHours: {
            type: "array",
            description: "ONLY when the source states working hours. Never estimated.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["day", "from", "to"],
              properties: {
                day: { type: "string", enum: [...WEEKDAYS] },
                from: { type: "string", description: "HH:MM, 24-hour" },
                to: { type: "string", description: "HH:MM, 24-hour; 24:00 for midnight" },
              },
            },
          },
        },
      },
    },
  },
} as const;

// ── proposal ────────────────────────────────────────────────────────────

export type ImportKind = "auto" | "services" | "staff";

export interface ServiceItemData {
  name: string;
  nameAr: string;
  durationMin: number;
  durationDefaulted: boolean;
  price: string | null;
  currency: string | null;
  color?: string;
  description?: string | null;
}

export interface StaffItemData {
  name: string;
  nameAr: string | null;
  role: string | null;
  schedule: WeeklySchedule;
  /** Service names to link (from the template's Services column), matched by normalized name at run time. */
  services: string[];
}

export interface ProposalItem {
  key: string;
  kind: "service" | "staff";
  data: ServiceItemData | StaffItemData;
  /** A non-archived catalog row (id) or an earlier item of this import (key) with the same normalized name. */
  duplicateOf: { id: string | null; key?: string; name: string } | null;
  selected: boolean;
  /** A field the source got wrong; the item starts unselected until fixed. */
  error?: { field: string; reason: string };
}

export interface ProposalNote {
  kind: "services" | "staff";
  kept: number;
  dropped: number;
}

export interface Proposal {
  items: ProposalItem[];
  notes: ProposalNote[];
}

export interface CatalogNames {
  services: { id: string; name: string; nameAr: string | null }[];
  staff: { id: string; name: string; nameAr: string | null }[];
}

const clip = (s: string | undefined | null, max: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** A raw proposed service (from the model or a template row) → item data + a field error, if any. */
export function serviceData(raw: {
  name?: string;
  nameAr?: string;
  durationMin?: number | null;
  price?: unknown;
  currency?: string | null;
  description?: string | null;
}): { data: ServiceItemData; error?: ProposalItem["error"] } {
  const name = clip(raw.name, MAX_NAME_LENGTH) || clip(raw.nameAr, MAX_NAME_LENGTH);
  const nameAr = clip(raw.nameAr, MAX_NAME_LENGTH) || name;
  const defaulted = raw.durationMin === undefined || raw.durationMin === null;
  const data: ServiceItemData = {
    name,
    nameAr,
    durationMin: defaulted ? DEFAULT_DURATION_MIN : (raw.durationMin as number),
    durationDefaulted: defaulted,
    price: null,
    currency: null,
    description: raw.description ? clip(raw.description, MAX_TEXT) : null,
  };
  let error: ProposalItem["error"];
  try {
    data.price = parsePrice(raw.price);
  } catch {
    error = { field: "price", reason: "invalid" };
  }
  if (raw.currency) {
    try {
      data.currency = parseCurrency(raw.currency);
    } catch {
      data.currency = null; // unknown currency → the workspace default at run time
    }
  }
  const check = validateServiceData(data);
  return { data, error: error ?? check };
}

export function staffData(raw: {
  name?: string;
  nameAr?: string | null;
  role?: string | null;
  schedule?: unknown;
  services?: string[];
}): { data: StaffItemData; error?: ProposalItem["error"] } {
  const data: StaffItemData = {
    name: clip(raw.name, MAX_NAME_LENGTH) || clip(raw.nameAr, MAX_NAME_LENGTH),
    nameAr: clip(raw.nameAr, MAX_NAME_LENGTH) || null,
    role: clip(raw.role, MAX_ROLE_LENGTH) || null,
    schedule: {},
    services: (raw.services ?? []).map((s) => clip(s, MAX_NAME_LENGTH)).filter(Boolean).slice(0, 50),
  };
  let error: ProposalItem["error"];
  try {
    data.schedule = validateSchedule(raw.schedule ?? {});
  } catch {
    error = { field: "schedule", reason: "invalid" };
  }
  return { data, error: error ?? validateStaffData(data) };
}

/** Field check of a service item; returns the first bad field. */
export function validateServiceData(d: ServiceItemData): ProposalItem["error"] | undefined {
  try {
    parseName(d.name);
  } catch {
    return { field: "name", reason: "invalid" };
  }
  try {
    parseName(d.nameAr);
  } catch {
    return { field: "nameAr", reason: "invalid" };
  }
  try {
    parseDuration(d.durationMin);
  } catch {
    return { field: "durationMin", reason: "out_of_range" };
  }
  try {
    parsePrice(d.price);
  } catch {
    return { field: "price", reason: "invalid" };
  }
  if (d.currency !== null && d.currency !== undefined) {
    try {
      parseCurrency(d.currency);
    } catch {
      return { field: "currency", reason: "invalid" };
    }
  }
  if (d.color !== undefined) {
    try {
      parseColor(d.color);
    } catch {
      return { field: "color", reason: "invalid" };
    }
  }
  return undefined;
}

export function validateStaffData(d: StaffItemData): ProposalItem["error"] | undefined {
  try {
    parseName(d.name);
  } catch {
    return { field: "name", reason: "invalid" };
  }
  try {
    parseOptionalName(d.nameAr);
  } catch {
    return { field: "nameAr", reason: "invalid" };
  }
  try {
    parseRole(d.role);
  } catch {
    return { field: "role", reason: "invalid" };
  }
  try {
    validateSchedule(d.schedule);
  } catch {
    return { field: "schedule", reason: "invalid" };
  }
  if (!Array.isArray(d.services) || d.services.some((s) => typeof s !== "string")) {
    return { field: "services", reason: "invalid" };
  }
  return undefined;
}

/** Working hours as the model returns them → a WeeklySchedule input (validated later). */
export function hoursToSchedule(hours: { day: string; from: string; to: string }[] | undefined): Record<string, { from: string; to: string }[]> {
  const out: Record<string, { from: string; to: string }[]> = {};
  for (const h of hours ?? []) (out[h.day] ??= []).push({ from: h.from, to: h.to });
  return out;
}

/** Raw proposed rows (from the model or a template) → the review proposal, with caps and dedupe. */
export function buildProposal(
  raw: { services: Parameters<typeof serviceData>[0][]; staff: Parameters<typeof staffData>[0][] },
  kind: ImportKind,
  catalog: CatalogNames,
): Proposal {
  const notes: ProposalNote[] = [];
  const services = kind === "staff" ? [] : raw.services;
  const staff = kind === "services" ? [] : raw.staff;
  if (services.length > MAX_PROPOSED_SERVICES) notes.push({ kind: "services", kept: MAX_PROPOSED_SERVICES, dropped: services.length - MAX_PROPOSED_SERVICES });
  if (staff.length > MAX_PROPOSED_STAFF) notes.push({ kind: "staff", kept: MAX_PROPOSED_STAFF, dropped: staff.length - MAX_PROPOSED_STAFF });

  const items: ProposalItem[] = [];
  const push = (kindOf: "service" | "staff", key: string, built: { data: ServiceItemData | StaffItemData; error?: ProposalItem["error"] }) => {
    const existing = kindOf === "service" ? catalog.services : catalog.staff;
    const names = [built.data.name, built.data.nameAr].map(normalizeName).filter(Boolean);
    const inCatalog = existing.find((e) => [e.name, e.nameAr].map(normalizeName).some((n) => n && names.includes(n)));
    const earlier = inCatalog
      ? undefined
      : items.find(
          (i) => i.kind === kindOf && [i.data.name, i.data.nameAr].map(normalizeName).some((n) => n && names.includes(n)),
        );
    const duplicateOf = inCatalog
      ? { id: inCatalog.id, name: inCatalog.name }
      : earlier
        ? { id: null, key: earlier.key, name: earlier.data.name }
        : null;
    items.push({
      key,
      kind: kindOf,
      data: built.data,
      duplicateOf,
      // Duplicates and rows with a bad field start unchecked.
      selected: !duplicateOf && !built.error,
      ...(built.error ? { error: built.error } : {}),
    });
  };
  services.slice(0, MAX_PROPOSED_SERVICES).forEach((s, i) => push("service", `s${i + 1}`, serviceData(s)));
  staff.slice(0, MAX_PROPOSED_STAFF).forEach((s, i) => push("staff", `t${i + 1}`, staffData(s)));
  return { items, notes };
}

/** A validated model reply → raw proposed rows. */
export function fromExtraction(x: Extraction) {
  return {
    services: x.services.map((s) => ({
      name: s.title,
      nameAr: s.titleAr,
      durationMin: s.durationMinutes ?? null,
      price: s.priceAmount,
      currency: s.currency ?? null,
      description: s.description ?? null,
    })),
    staff: x.staff.map((s) => ({ name: s.title, role: s.role ?? null, schedule: hoursToSchedule(s.workingHours) })),
  };
}
