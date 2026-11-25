import { PROXY_ARGS_MAX_BYTES } from "./connector-catalog";

/**
 * SP-23: the JSON Schema subset the proxy checks tool arguments against
 * (Review Focus 2): type, properties, required, enum, items, minimum,
 * maximum, minLength, maxLength, additionalProperties. Unknown keywords are
 * ignored (the vendor validates again). Model output is untrusted: anything
 * that fails here never reaches the vendor.
 */
export interface ArgsError {
  path: string;
  code: "not_object" | "too_large" | "required" | "wrong_type" | "not_in_enum" | "too_small" | "too_big" | "too_short" | "too_long" | "unexpected";
}

type Schema = Record<string, unknown>;

const typeOf = (v: unknown): string => {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
};

function matchesType(v: unknown, t: unknown): boolean {
  const types = Array.isArray(t) ? t : [t];
  const actual = typeOf(v);
  return types.some((x) => x === actual || (x === "number" && actual === "integer"));
}

function check(v: unknown, s: unknown, path: string, out: ArgsError[], depth: number): void {
  if (!s || typeof s !== "object" || depth > 20 || out.length >= 20) return;
  const schema = s as Schema;
  if (schema.type !== undefined && !matchesType(v, schema.type)) {
    out.push({ path, code: "wrong_type" });
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) out.push({ path, code: "not_in_enum" });
  if (typeof v === "number") {
    if (typeof schema.minimum === "number" && v < schema.minimum) out.push({ path, code: "too_small" });
    if (typeof schema.maximum === "number" && v > schema.maximum) out.push({ path, code: "too_big" });
  }
  if (typeof v === "string") {
    if (typeof schema.minLength === "number" && v.length < schema.minLength) out.push({ path, code: "too_short" });
    if (typeof schema.maxLength === "number" && v.length > schema.maxLength) out.push({ path, code: "too_long" });
  }
  if (Array.isArray(v) && schema.items && typeof schema.items === "object") {
    v.forEach((item, i) => check(item, schema.items, `${path}[${i}]`, out, depth + 1));
  }
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const obj = v as Record<string, unknown>;
    const props = (schema.properties && typeof schema.properties === "object" ? schema.properties : {}) as Record<string, unknown>;
    if (Array.isArray(schema.required)) {
      for (const r of schema.required) if (typeof r === "string" && obj[r] === undefined) out.push({ path: path ? `${path}.${r}` : r, code: "required" });
    }
    for (const [k, val] of Object.entries(obj)) {
      const p = path ? `${path}.${k}` : k;
      if (k in props) check(val, props[k], p, out, depth + 1);
      else if (schema.additionalProperties === false) out.push({ path: p, code: "unexpected" });
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") check(val, schema.additionalProperties, p, out, depth + 1);
    }
  }
}

/** Validates tool arguments: an object, ≤ 64 KB, matching the schema. */
export function validateArgs(args: unknown, schema: unknown): { ok: true } | { ok: false; errors: ArgsError[] } {
  if (!args || typeof args !== "object" || Array.isArray(args)) return { ok: false, errors: [{ path: "", code: "not_object" }] };
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(args), "utf8");
  } catch {
    return { ok: false, errors: [{ path: "", code: "not_object" }] };
  }
  if (size > PROXY_ARGS_MAX_BYTES) return { ok: false, errors: [{ path: "", code: "too_large" }] };
  const errors: ArgsError[] = [];
  check(args, { type: "object", ...(schema && typeof schema === "object" ? (schema as Schema) : {}) }, "", errors, 0);
  return errors.length ? { ok: false, errors } : { ok: true };
}
