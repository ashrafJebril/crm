import type { RawToolDescriptor } from './ads-provider.port';

/**
 * THE SECURITY BOUNDARY for the Pipeboard passthrough.
 *
 * This is an ALLOWLIST of the tools `pipeboard_call` may execute directly, NOT a
 * denylist of the ones it may not. The inversion is the whole point:
 *
 *   • A tool ON this list is a benign, read-only Meta-Ads call → executes.
 *   • A tool NOT on this list — every write, and every tool Pipeboard ships
 *     TOMORROW that we have never classified — is GATED. It never executes in
 *     the tool loop; it returns {status:'confirmation_required'} and can only
 *     run later via the owner-authenticated approve endpoint.
 *
 * Fail-closed falls out of this for free: an unknown tool_name is simply absent
 * from the set, so it is treated as consequential and gated. A denylist would do
 * the opposite — a new Pipeboard tool would default to "not a known write" =
 * execute = fail OPEN. The cost of this choice is that a genuinely-benign new
 * read is briefly over-gated until a human adds it here; that is a wasted
 * approval click, versus an ungated write that spends money. Asymmetric. Correct.
 *
 * Provenance: the 109-tool split was MEASURED from a live tools/list on
 * 2026-07-17 — 54 tools carry readOnlyHint:true, 55 carry readOnlyHint:false,
 * exactly matching Pipeboard's docs, with ZERO disagreement against this list.
 * All 54 reads are allowlisted — including get_leads/get_lead (bulk/singular
 * customer-contact export), unlocked by explicit decision despite the customer
 * PII they return.
 * crossCheckAllowlist() re-verifies that agreement at every boot.
 */
export const PIPEBOARD_UNGATED: ReadonlySet<string> = new Set<string>([
  // ── Account & structure ──────────────────────────────────────────────────
  'get_ad_accounts',            // account ids/names/currency; no PII, no mutation
  'get_account_info',           // account status/currency metadata
  'get_account_pages',          // linked Pages (public ids/names)
  'get_page_ad_limit',          // a numeric cap
  'list_meta_connections',      // the account's OWN connections (owner identity, not customer PII)
  'get_pixels',                 // pixel ids/config

  // ── Campaign / adset / ad config ─────────────────────────────────────────
  'get_campaigns',              // [also WRAPPED] campaign list
  'get_campaign_details',
  'get_adsets',                 // targeting is CATEGORIES, not customer data
  'get_adset_details',
  'get_ads',
  'get_ad_details',
  'get_ad_rules',               // automated-rule definitions; config only

  // ── Insights / analytics ─────────────────────────────────────────────────
  'get_insights',               // [also WRAPPED] aggregate performance numbers
  'bulk_get_insights',          // [STEP 6: needs compact=true default — see discovery note] ad-level payloads run 500KB–5MB
  'get_facebook_page_insights',
  'get_instagram_account_insights',
  'estimate_audience_size',     // returns a size estimate; no PII, no state change

  // ── Eligibility / compute ────────────────────────────────────────────────
  'check_post_boost_eligibility',
  'compute_image_crops',        // pure computation on an image; changes nothing

  // ── Creatives & media ────────────────────────────────────────────────────
  'get_ad_creatives',           // [STEP 6: REDACT] asset_feed_spec can carry customer phone numbers
  'get_creative_details',       // [STEP 6: REDACT] same
  'bulk_get_ad_creatives',      // [STEP 6: REDACT] same
  'get_ad_image',               // [STEP 6: CEILING] a signed image URL
  'get_image_by_hash',
  'list_ad_images',
  'get_ad_video',               // [STEP 6: CEILING] signed video URLs, ~2913 B/item
  'get_ad_previews',            // preview HTML/URL; rendering only
  'get_facebook_posts',         // the Page's OWN posts; public content

  // ── Instagram & social ───────────────────────────────────────────────────
  'get_instagram_accounts',
  'get_instagram_posts',
  'get_post_comments',          // [STEP 6: REDACT] includes commenter names
  'get_account_activities',     // [STEP 6: REDACT] internal actor_id/actor_name — keep what/when, redact who

  // ── Audiences & resolvers ────────────────────────────────────────────────
  'get_custom_audiences',       // [STEP 6: CEILING] 62KB; membership is HASHED and never returned → volume, not PII
  'get_saved_audiences',
  'resolve_branded_content_creator',
  'resolve_instagram_media',

  // ── Targeting search — pure taxonomy / session-cache lookups ─────────────
  'search_interests',
  'bulk_search_interests',
  'get_interest_suggestions',
  'search_behaviors',
  'search_demographics',
  'search_geo_locations',
  'search_pages_by_name',
  'search',                     // readOnlyHint:true — searches cached records, returns matching ids
  'fetch',                      // readOnlyHint:true — returns ONLY records a prior search cached; makes NO Meta call

  // ── Studies / catalogs / rules / value sets — config reads ───────────────
  'get_ad_study',
  'list_ad_studies',
  'get_lead_gen_forms',         // form TEMPLATES (not submissions). Contrast get_leads/get_lead below (raw submissions).
  'get_leads',                  // [PII] lead-form SUBMISSIONS — names/phones/emails. Ungated by explicit decision (Feras): raw leads flow to the model + persist in AdsChatMessage.
  'get_lead',                   // [PII] a single lead submission — same customer-contact export as get_leads.
  'list_catalogs',
  'list_product_sets',
  'list_value_rule_sets',
]);
// Count MUST be 54. If you add/remove, update the count assertion below and the
// reconciliation math (54 ungated reads = all reads, 0 withheld; + 55 writes = 109).
if (PIPEBOARD_UNGATED.size !== 54) {
  throw new Error(`PIPEBOARD_UNGATED must hold exactly 54 tools, has ${PIPEBOARD_UNGATED.size}`);
}

/** The gate's one question. Not on the list → consequential → confirmation required. */
export function isUngatedPipeboardTool(name: string): boolean {
  return PIPEBOARD_UNGATED.has(name);
}

/**
 * Startup tripwire, ONE-DIRECTIONAL by design: it can only ever make us STRICTER.
 *
 * `fatal`  — a tool WE allowlist that Pipeboard marks NON-read-only
 *            (readOnlyHint:false or destructiveHint:true). That means we are too
 *            loose: a tool we would execute ungated actually mutates. Refuse to
 *            boot; a human must pull it off the list.
 * `warn`   — drift that is not a safety hole: an allowlisted tool that has
 *            vanished from tools/list (can't be called anyway), or a brand-new
 *            tool we've never classified (already gated by fail-closed; surfaced
 *            only for visibility so someone reviews whether it's a benign read).
 *
 * We NEVER auto-promote: a Pipeboard hint can never move a tool ONTO the
 * allowlist. Only a human editing PIPEBOARD_UNGATED can. That keeps a
 * compromised/buggy server from mislabeling a write as read-only to slip our gate.
 */
export function crossCheckAllowlist(tools: RawToolDescriptor[]): { fatal: string[]; warn: string[] } {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const fatal: string[] = [];
  const warn: string[] = [];

  for (const name of PIPEBOARD_UNGATED) {
    const t = byName.get(name);
    if (!t) { warn.push(`allowlisted tool '${name}' is absent from tools/list (drift, not unsafe)`); continue; }
    const ro = t.annotations?.readOnlyHint;
    const destr = t.annotations?.destructiveHint;
    if (ro === false || destr === true) {
      fatal.push(`allowlisted tool '${name}' is marked NON-read-only by Pipeboard (readOnlyHint=${ro}, destructiveHint=${destr}) — too loose, remove it from PIPEBOARD_UNGATED`);
    }
  }

  const known = new Set(PIPEBOARD_UNGATED);
  for (const t of tools) {
    if (t.annotations?.readOnlyHint === true && !known.has(t.name)) {
      warn.push(`new read-only tool '${t.name}' is not classified — gated by default; review whether it is a benign read`);
    }
  }

  return { fatal, warn };
}
