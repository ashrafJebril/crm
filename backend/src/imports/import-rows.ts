import { isEmail } from "class-validator";
import { normalizeLifecycle, splitName, joinName } from "../contacts/contact-name";
import { validateValue } from "../custom-fields/custom-fields.service";
import { normalizeImportPhone } from "./phone";

export const IMPORT_BATCH_SIZE = 500;
export const MAX_STORED_ERRORS = 50;
/** Same ceiling as the bulk "add to pipeline" action. */
export const IMPORT_PIPELINE_CAP = 500;

export type MatchBy = "phone_then_email" | "phone" | "email";

export interface ImportOptions {
  matchBy: MatchBy;
  updateExisting: boolean;
  tags?: string[];
  ownerId?: string;
  groupId?: string;
  newGroupName?: string;
  pipeline?: { pipelineId: string; stageId?: string };
}

/** Header name -> target (see MAPPING_TARGETS; custom fields are `custom:<defId>`). */
export type ImportMapping = Record<string, string>;

export const SIMPLE_TARGETS = [
  "firstName",
  "lastName",
  "name",
  "phone",
  "email",
  "lifecycle",
  "tags",
  "owner",
  "source",
  "industry",
  "value",
  "ignore",
] as const;

export interface FieldDef {
  id: string;
  key: string;
  label: string;
  labelAr: string;
  type: string;
  options: unknown;
}

export interface ImportContext {
  /** Default dialling code from the workspace timezone (digits) or null. */
  cc: string | null;
  headers: string[];
  mapping: ImportMapping;
  options: ImportOptions;
  defs: Map<string, FieldDef>;
  ownersByEmail: Map<string, string>;
  ownersByName: Map<string, string>;
}

export interface NormalizedRow {
  name: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  email: string | null;
  lifecycle: string | null;
  source: string | null;
  industry: string | null;
  value: string | null;
  tags: string[];
  ownerId: string | null;
  custom: Record<string, unknown>;
}

export interface RowError {
  column: string | null;
  key: string;
}

export type NormalizeResult =
  | { ok: true; rec: NormalizedRow }
  | { ok: false; errors: RowError[] };

const TAG_SPLIT = /[,;،]/;
const TAG_MAX = 40;
const TRUE_WORDS = new Set(["true", "yes", "y", "1", "نعم", "ايوه", "أيوه"]);
const FALSE_WORDS = new Set(["false", "no", "n", "0", "لا"]);

function cellToCustom(def: FieldDef, raw: string): unknown {
  const t = raw.trim();
  if (def.type === "boolean") {
    const w = t.toLowerCase();
    if (TRUE_WORDS.has(w)) return true;
    if (FALSE_WORDS.has(w)) return false;
    return raw; // fails the validator
  }
  if (def.type === "select" && Array.isArray(def.options)) {
    const hit = (def.options as string[]).find((o) => o.toLowerCase() === t.toLowerCase());
    return hit ?? t;
  }
  return t;
}

/** Validate and normalize one source row. Pure: no database access. */
export function normalizeRow(cells: string[], ctx: ImportContext): NormalizeResult {
  const errors: RowError[] = [];
  const get: Record<string, { v: string; col: string }> = {};
  const custom: Record<string, unknown> = {};
  const tags = new Set<string>();

  ctx.headers.forEach((header, i) => {
    const target = ctx.mapping[header];
    if (!target || target === "ignore") return;
    const raw = String(cells[i] ?? "").trim();
    if (!raw) return;
    if (target === "tags") {
      for (const part of raw.split(TAG_SPLIT)) {
        const t = part.trim().slice(0, TAG_MAX);
        if (t) tags.add(t);
      }
    } else if (target.startsWith("custom:")) {
      const def = ctx.defs.get(target.slice(7));
      if (!def) return;
      try {
        custom[def.id] = validateValue(def, cellToCustom(def, raw));
      } catch {
        errors.push({ column: header, key: "imports.err.bad_custom_value" });
      }
    } else if (!(target in get)) {
      get[target] = { v: raw, col: header };
    }
  });

  let email: string | null = null;
  if (get.email) {
    const e = get.email.v.toLowerCase();
    if (isEmail(e)) email = e;
    else errors.push({ column: get.email.col, key: "imports.err.bad_email" });
  }

  let phone: string | null = null;
  if (get.phone) {
    phone = normalizeImportPhone(get.phone.v, ctx.cc);
    if (!phone) errors.push({ column: get.phone.col, key: "imports.err.bad_phone" });
  }

  let ownerId: string | null = null; // options.ownerId applies to created contacts only (runner)
  if (get.owner) {
    const o = get.owner.v.toLowerCase();
    const id = ctx.ownersByEmail.get(o) ?? ctx.ownersByName.get(o);
    if (id) ownerId = id;
    else errors.push({ column: get.owner.col, key: "imports.err.owner_not_found" });
  }

  let name = "";
  let firstName: string | null = null;
  let lastName: string | null = null;
  if (get.firstName || get.lastName) {
    firstName = get.firstName?.v ?? null;
    lastName = get.lastName?.v ?? null;
    name = joinName(firstName, lastName);
  } else if (get.name) {
    name = get.name.v;
    const parts = splitName(name);
    firstName = parts.firstName || null;
    lastName = parts.lastName;
  }

  if (!name && !phone && !email && !errors.some((e) => e.key === "imports.err.bad_phone" || e.key === "imports.err.bad_email")) {
    errors.push({ column: null, key: "imports.err.no_identity" });
  }
  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    rec: {
      name: name || phone || email || "",
      firstName: name ? firstName : null,
      lastName: name ? lastName : null,
      phone,
      email,
      lifecycle: get.lifecycle ? normalizeLifecycle(get.lifecycle.v) : null,
      source: get.source?.v ?? null,
      industry: get.industry?.v ?? null,
      value: get.value?.v ?? null,
      tags: [...tags],
      ownerId,
      custom,
    },
  };
}

/** Identity keys of a row for in-file duplicate detection and matching. */
export function rowKeys(rec: NormalizedRow, matchBy: MatchBy): string[] {
  const keys: string[] = [];
  if (rec.phone && matchBy !== "email") keys.push(`p:${rec.phone}`);
  if (rec.email && matchBy !== "phone") keys.push(`e:${rec.email}`);
  return keys;
}

/** In-file duplicate detection: the first row with a key wins. */
export class DupTracker {
  private readonly seen = new Set<string>();

  constructor(private readonly matchBy: MatchBy) {}

  /** True when an earlier row already claimed one of this row's keys. */
  isDuplicate(rec: NormalizedRow): boolean {
    const keys = rowKeys(rec, this.matchBy);
    if (keys.some((k) => this.seen.has(k))) return true;
    for (const k of keys) this.seen.add(k);
    return false;
  }
}

/** Stored forms a phone may have in the database for one E.164 number. */
export function phoneVariants(e164: string, cc: string | null): string[] {
  const digits = e164.replace(/^\+/, "");
  const out = new Set<string>([e164, digits, `00${digits}`]);
  if (cc && digits.startsWith(cc)) out.add(`0${digits.slice(cc.length)}`);
  return [...out];
}
