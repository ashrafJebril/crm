import { HttpException, Logger } from "@nestjs/common";
import type { ZernioBudget } from "../../campaigns/sending/zernio-budget";
import type { ZernioClient, ZernioNumberInfo } from "../../integrations/zernio.client";
import { zernioHealthCall } from "./health-budget";
import type { FieldName, RawField, RawHealthRead, RawTemplate } from "./health-model";

const log = new Logger("ZernioHealthReader");
const ALL_FIELDS: FieldName[] = [
  "quality",
  "tier",
  "nameStatus",
  "verified",
  "codeVerification",
  "messaging",
  "phoneStatus",
  "accountReview",
];

/** Zernio says the account is gone (404, or its "account not found" text,
 *  which the client rewrites to the reconnect message). */
export function isAccountGone(e: unknown): boolean {
  if (!(e instanceof HttpException)) return false;
  if (e.getStatus() === 404) return true;
  const r = e.getResponse();
  const msg = typeof r === "string" ? r : String((r as { message?: unknown })?.message ?? "");
  return /account not found|connection was removed by Meta/i.test(msg);
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Ruling R1: an undocumented field is read only when Zernio sent it. */
const passthrough = (v: unknown): RawField => ({ value: v, passthrough: true });

/**
 * SP-14: a Zernio number's health in 2 budgeted calls (number-info, then the
 * templates list). Documented fields: quality, tier, name status, phone
 * status and Meta's `health_status` (messaging). Business verification, code
 * verification and account review are undocumented: read only when Zernio
 * passes Meta's value through, else `unsupported`. Template quality likewise.
 * A 404 / "account not found" makes every field `check_failed` (the channel
 * status stays the Zernio sync's job). Never throws.
 */
export async function readZernioHealth(
  zernio: Pick<ZernioClient, "whatsappNumberInfo" | "whatsappTemplates">,
  budget: ZernioBudget | undefined,
  accountId: string | null,
): Promise<RawHealthRead> {
  const fields: RawHealthRead["fields"] = {};
  if (!accountId) {
    for (const f of ALL_FIELDS) fields[f] = { error: "missing_credentials" };
    return { provider: "zernio", fields, templates: { error: "missing_credentials" } };
  }

  let info: ZernioNumberInfo | null = null;
  try {
    info = await zernioHealthCall(() => zernio.whatsappNumberInfo(accountId), budget);
  } catch (e) {
    const gone = isAccountGone(e);
    log.warn(`number-info failed for a Zernio account: ${e instanceof HttpException ? e.getStatus() : "error"}`);
    for (const f of ALL_FIELDS) fields[f] = { error: "check_failed" };
    if (gone) return { provider: "zernio", fields, templates: { error: "check_failed" } };
  }

  if (info) {
    const phone = isObj(info.phone) ? info.phone : null;
    const waba = isObj(info.waba) ? info.waba : null;
    const documented = (v: unknown): RawField => (phone ? { value: v } : { error: "check_failed" });
    // A response without a `phone` object read nothing: check_failed, not a guess.
    fields.quality = documented(phone?.quality_rating);
    fields.tier = documented(phone?.messaging_limit_tier);
    fields.nameStatus = documented(phone?.name_status);
    fields.phoneStatus = documented(phone?.status);
    fields.messaging = documented(phone?.health_status);
    fields.codeVerification = passthrough(phone?.code_verification_status);
    fields.verified = passthrough(waba?.business_verification_status);
    fields.accountReview = passthrough(waba?.account_review_status);
  }

  let templates: RawHealthRead["templates"];
  try {
    const list = await zernioHealthCall(() => zernio.whatsappTemplates(accountId), budget);
    const items: RawTemplate[] = (Array.isArray(list) ? list : []).map((t) => ({
      id: t.id ? String(t.id) : null,
      name: String(t.name ?? ""),
      language: String(t.language ?? ""),
      status: t.status,
      category: t.category ? String(t.category) : null,
      ...(isObj(t.quality_score) && t.quality_score.score !== undefined ? { qualityScore: t.quality_score.score } : {}),
    }));
    templates = { items, truncated: false };
  } catch (e) {
    log.warn(`templates read failed for a Zernio account: ${e instanceof HttpException ? e.getStatus() : "error"}`);
    templates = { error: "check_failed" };
  }
  return { provider: "zernio", fields, templates };
}
