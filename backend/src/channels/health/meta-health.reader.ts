import { MetaGraphError, type MetaGraphClient } from "../whatsapp/meta-graph.client";
import type { FieldName, RawField, RawHealthRead, RawTemplate, SignalError } from "./health-model";

/** Graph codes that mean the token may not read this node (OAuth, permission, access). */
const PERMISSION_CODES = new Set([10, 190, 200]);
/** Templates: at most this many pages of 100. */
export const META_TEMPLATE_PAGES = 5;

const PHONE_FIELDS: Array<[Exclude<FieldName, "tier">, string]> = [
  ["quality", "quality_rating"],
  ["nameStatus", "name_status"],
  ["codeVerification", "code_verification_status"],
  ["messaging", "health_status"],
  ["phoneStatus", "status"],
];
const WABA_FIELDS: Array<[FieldName, string]> = [
  ["verified", "business_verification_status"],
  ["accountReview", "account_review_status"],
];
/** The new limit field first, then the deprecated one (ruling 13). */
export const LIMIT_FIELDS = ["whatsapp_business_manager_messaging_limit", "messaging_limit_tier"] as const;

/** A Graph failure as an error key. Graph text is never kept (it can echo input). */
export function graphErrorKey(e: unknown): Exclude<SignalError, null> {
  return e instanceof MetaGraphError && e.code !== null && PERMISSION_CODES.has(e.code) ? "permission_denied" : "check_failed";
}

/**
 * SP-14: a Meta-direct number's health, one Graph field per call (as Tkana
 * does), so a field one Graph version does not know fails alone.
 *  - phone (`creds.externalId`): quality_rating, the messaging limit (new
 *    field, then the deprecated one), name_status, code_verification_status,
 *    health_status, status;
 *  - WABA: business_verification_status, account_review_status;
 *  - templates: at most 5 pages of 100.
 * No token → every field `missing_credentials` with zero Graph calls; no
 * WABA id → the WABA fields and templates `missing_credentials`. Never
 * throws, never logs (the client logs scrubbed URLs and codes only).
 */
export async function readMetaHealth(
  graph: Pick<MetaGraphClient, "getField" | "listTemplates">,
  creds: { accessToken?: string; externalId: string | null },
  wabaId: string | null,
): Promise<RawHealthRead> {
  const token = creds.accessToken;
  const phoneId = creds.externalId;
  const fields: RawHealthRead["fields"] = {};
  const missing: RawField = { error: "missing_credentials" };
  if (!token) {
    for (const [f] of [...PHONE_FIELDS, ...WABA_FIELDS]) fields[f] = missing;
    fields.tier = missing;
    return { provider: "meta", accountId: phoneId ?? null, fields, templates: { error: "missing_credentials" } };
  }

  const one = async (node: string, field: string): Promise<RawField> => {
    try {
      return { value: await graph.getField(node, field, token) };
    } catch (e) {
      return { error: graphErrorKey(e) };
    }
  };

  const tasks: Array<Promise<void>> = [];
  if (phoneId) {
    for (const [f, gf] of PHONE_FIELDS) tasks.push(one(phoneId, gf).then((r) => void (fields[f] = r)));
    tasks.push(
      (async () => {
        let r = await one(phoneId, LIMIT_FIELDS[0]);
        if ("error" in r || r.value === undefined || r.value === null) r = await one(phoneId, LIMIT_FIELDS[1]);
        fields.tier = r;
      })(),
    );
  } else {
    for (const [f] of PHONE_FIELDS) fields[f] = missing;
    fields.tier = missing;
  }
  if (wabaId) {
    for (const [f, gf] of WABA_FIELDS) tasks.push(one(wabaId, gf).then((r) => void (fields[f] = r)));
  } else {
    for (const [f] of WABA_FIELDS) fields[f] = missing;
  }

  let templates: RawHealthRead["templates"] = { error: "missing_credentials" };
  if (wabaId) {
    tasks.push(
      (async () => {
        const items: RawTemplate[] = [];
        let after: string | undefined;
        let truncated = false;
        try {
          for (let page = 0; page < META_TEMPLATE_PAGES; page++) {
            const res = await graph.listTemplates(wabaId, token, after ? { after } : {});
            for (const t of res.data) {
              items.push({
                id: t.id ? String(t.id) : null,
                name: String(t.name ?? ""),
                language: String(t.language ?? ""),
                status: t.status,
                category: t.category ? String(t.category) : null,
                ...(t.quality_score && typeof t.quality_score === "object" && "score" in t.quality_score
                  ? { qualityScore: t.quality_score.score }
                  : {}),
              });
            }
            if (!res.after) break;
            after = res.after;
            if (page === META_TEMPLATE_PAGES - 1) truncated = true;
          }
          templates = { items, truncated };
        } catch (e) {
          // A partial list would undercount: the whole summary is unknown.
          templates = { error: graphErrorKey(e) };
        }
      })(),
    );
  }
  await Promise.all(tasks);
  return { provider: "meta", accountId: phoneId ?? null, fields, templates };
}
