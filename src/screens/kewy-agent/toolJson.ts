/**
 * The optional JSON boxes of "Add tool": headers, a body template and what each
 * parameter means. Empty means "not set". Anything else must be a JSON object;
 * headers and parameter descriptions also need text values.
 */
export type JsonField = "headers" | "body_template" | "param_descriptions";

export type ParsedToolJson =
  | { ok: true; headers?: Record<string, string>; body_template?: Record<string, unknown>; param_descriptions?: Record<string, string> }
  | { ok: false; field: JsonField };

function parseObject(raw: string): Record<string, unknown> | null | undefined {
  if (!raw.trim()) return undefined;
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function allText(o: Record<string, unknown>): o is Record<string, string> {
  return Object.values(o).every((v) => typeof v === "string");
}

export function parseToolJson(raw: Record<JsonField, string>): ParsedToolJson {
  const headers = parseObject(raw.headers);
  if (headers === null || (headers && !allText(headers))) return { ok: false, field: "headers" };
  const body = parseObject(raw.body_template);
  if (body === null) return { ok: false, field: "body_template" };
  const params = parseObject(raw.param_descriptions);
  if (params === null || (params && !allText(params))) return { ok: false, field: "param_descriptions" };
  return {
    ok: true,
    ...(headers ? { headers } : {}),
    ...(body ? { body_template: body } : {}),
    ...(params ? { param_descriptions: params } : {}),
  };
}
