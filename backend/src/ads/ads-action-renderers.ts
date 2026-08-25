// hjz-ads — machine renderers for gated write proposals (STEP 5).
//
// Turns a redacted {tool, args} into a readable Levantine-Arabic summary a business
// owner can approve on — "what will happen", not a field dump — and flips
// summaryIsPlaceholder=false so the approve endpoint (and the card's موافق) opens.
//
// SAFETY (do NOT weaken):
//  • Renders from REDACTED args only — no customer PII in the summary/card/audit.
//    (Ad copy in create_ad_creative is the OWNER'S own text, not customer PII → shown.)
//  • The REAL account currency is FETCHED (getAdAccounts / entity-details), never
//    guessed, and formatted with the currency's own exponent (JOD=3, USD=2) via Intl.
//    There is NO /100 estimate here and there must never be one: a value like 500
//    minor units is "0.500 د.أ" on a JOD account, NOT "~5".
//  • ANY gap — no renderer for the tool, an amount whose currency can't be resolved,
//    a failed entity read, or a missing summary-critical arg — returns PLACEHOLDER,
//    which keeps summaryIsPlaceholder=true → the action is NOT approvable. The
//    interim fallback text lives in the gate (renderFallbackSummary).
//
// INVARIANT NOTE — the currency/entity fetches are ALLOWLISTED READS
// (get_ad_accounts, get_*_details) on the PROPOSE path. They are what make the shown
// amount honest. They do NOT touch the gated WRITE — no gated tool reaches the
// provider without approval; that invariant is untouched. Do NOT "restore purity" by
// deleting these reads: doing so reintroduces a guessed/estimated amount, which is
// the exact bug this step kills.
//
// v1 renders ARABIC (the Jordan market; default locale 'ar'). EN summaries are a
// follow-up — until then an en-locale chat gets English card labels with an Arabic
// summary body.

import type { AdsProviderPort } from './ads-provider.port';

export interface Rendered {
  summary: string;
  isPlaceholder: boolean;
}
const PLACEHOLDER: Rendered = { summary: '', isPlaceholder: true };
const ok = (summary: string): Rendered => ({ summary, isPlaceholder: false });
// A placeholder WITH an honest, specific reason (shown on the card, موافق disabled) —
// use when we can say exactly what's missing, e.g. a NAME was passed where the tool
// needs an id. The gate shows this text instead of the generic fallback.
const blocked = (summary: string): Rendered => ({ summary, isPlaceholder: true });

// ── value coercion ──────────────────────────────────────────────────────────
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
function toNum(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
// Meta entity ids are long numeric strings (e.g. "120251066534050700"); a NAME is not.
// Catches Salma passing a name where update_* needs an id (the measured failure mode).
function isMetaId(s: string | undefined): s is string {
  return typeof s === 'string' && /^\d{5,}$/.test(s);
}

// ── currency (exponent-aware; NEVER guessed) ────────────────────────────────
// Returns the formatted amount in the account currency, or null when the currency
// is unknown/invalid — null forces the caller to PLACEHOLDER, never a guess.
function formatMinor(minor: number, currency: string): string | null {
  try {
    // numberingSystem 'latn' → western digits (matches the approved card text
    // "15.000 د.أ"); the currency symbol + the RIGHT exponent still come from Intl
    // (JOD=3 decimals, USD=2), so 500 minor → JOD "0.500 د.أ", USD "US$5.00".
    const nf = new Intl.NumberFormat('ar-JO', { style: 'currency', currency, numberingSystem: 'latn' });
    const exp = nf.resolvedOptions().maximumFractionDigits ?? 2;
    return nf.format(minor / Math.pow(10, exp));
  } catch {
    return null; // invalid ISO code → not formattable → caller placeholders
  }
}

// ── translation maps (Meta enum → business-owner Arabic) ────────────────────
const OBJECTIVE_PHRASE: Record<string, string> = {
  OUTCOME_LEADS: 'تجيبلك عملاء محتملين (ليدز، يعني ناس مهتمّة تسجّل بياناتها عندك)',
  OUTCOME_SALES: 'تزيدلك المبيعات',
  OUTCOME_AWARENESS: 'توصّل اسم منشأتك لأكبر عدد من الناس (وعي بالعلامة)',
  OUTCOME_TRAFFIC: 'تجيبلك زيارات لموقعك أو صفحتك',
  OUTCOME_ENGAGEMENT: 'تزيد التفاعل مع منشوراتك وصفحتك',
  OUTCOME_APP_PROMOTION: 'تروّج لتطبيقك',
};
const GOAL_PHRASE: Record<string, string> = {
  LEAD_GENERATION: 'تجمعلك ليدز',
  QUALITY_LEAD: 'تجمعلك ليدز بجودة أعلى',
  QUALITY_CALL: 'تجيبلك مكالمات',
  LINK_CLICKS: 'تجيبلك نقرات عالرابط',
  LANDING_PAGE_VIEWS: 'تجيبلك زيارات لصفحة الهبوط',
  CONVERSATIONS: 'تفتحلك محادثات',
  OFFSITE_CONVERSIONS: 'تجيبلك تحويلات',
  REACH: 'توصّلك لأكبر عدد من الناس',
  IMPRESSIONS: 'تزيد ظهور إعلانك',
  THRUPLAY: 'تزيد مشاهدات الفيديو',
  POST_ENGAGEMENT: 'تزيد التفاعل مع المنشور',
  VALUE: 'تعظّم قيمة المبيعات',
};
const BILLING_PHRASE: Record<string, string> = {
  IMPRESSIONS: 'والفوترة على الظهور (بتنحسب كل ما بينعرض إعلانك، مش على النقر)',
  LINK_CLICKS: 'والفوترة على النقر (بتنحسب كل ما حدا بينقر على إعلانك)',
};
const CTA_PHRASE: Record<string, string> = {
  BOOK_NOW: 'احجز الآن', MESSAGE_PAGE: 'راسلنا', CALL_NOW: 'اتصل الآن',
  SHOP_NOW: 'تسوّق الآن', LEARN_MORE: 'اعرف أكثر', SIGN_UP: 'سجّل الآن',
  GET_OFFER: 'احصل على العرض', WHATSAPP_MESSAGE: 'راسلنا واتساب',
  INSTAGRAM_MESSAGE: 'راسلنا انستقرام', SUBSCRIBE: 'اشترك', CONTACT_US: 'تواصل معنا',
  APPLY_NOW: 'قدّم الآن', GET_QUOTE: 'اطلب عرض سعر', DONATE_NOW: 'تبرّع الآن',
};

// ── memoized provider reads (per request) ───────────────────────────────────
// One getAdAccounts + one details-read per entity per request; several proposals in
// one turn share the caches. Every read is failure-swallowed (→ null/[]) so a
// provider blip degrades to PLACEHOLDER, never THROWS into the gate loop (a throw
// there would retry the whole dispatch and re-mint the proposal). See INVARIANT NOTE.
export interface RenderCtx {
  currencyForAccount(accountId: string | undefined): Promise<string | null>;
  entity(kind: EntityKind, id: string | undefined): Promise<unknown>;
  entityName(kind: EntityKind, id: string | undefined): Promise<string | null>;
}
type EntityKind = 'campaign' | 'adset' | 'ad' | 'creative';
const DETAILS_TOOL: Record<EntityKind, string> = {
  campaign: 'get_campaign_details', adset: 'get_adset_details', ad: 'get_ad_details', creative: 'get_creative_details',
};
const ID_ARG: Record<EntityKind, string> = {
  campaign: 'campaign_id', adset: 'adset_id', ad: 'ad_id', creative: 'creative_id',
};

// callRaw returns the provider's UNMAPPED payload; its wrapper shape isn't
// guaranteed, so read defensively across the object and common wrappers.
function pick(raw: unknown, ...names: string[]): unknown {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, any>;
  const bases = [r, r.data, r.result, r.campaign, r.adset, r.ad, r.creative].filter((b) => b && typeof b === 'object');
  for (const b of bases) for (const n of names) if (b[n] != null) return b[n];
  return undefined;
}
// Meta sometimes returns account_id without the "act_" prefix; getAdAccounts ids
// carry it. Normalize so the currency lookup matches.
export function normAccountId(v: unknown): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  return s.startsWith('act_') ? s : `act_${s}`;
}

export function createRenderCtx(provider: AdsProviderPort): RenderCtx {
  let accountsP: Promise<any[]> | null = null;
  const accounts = (): Promise<any[]> =>
    (accountsP ??= Promise.resolve().then(() => provider.getAdAccounts()).then((a) => (a as any[]) ?? []).catch(() => []));
  const entityCache = new Map<string, Promise<unknown>>();

  const currencyForAccount = async (accountId: string | undefined): Promise<string | null> => {
    const isIso = (c: unknown): c is string => typeof c === 'string' && /^[A-Z]{3}$/.test(c);
    const list = await accounts();
    const id = str(accountId);
    // Normal path: id present AND matches a known account with a valid currency (the
    // create path passes account_id in its args → resolves here exactly as before).
    if (id) {
      const acc = list.find((a) => a?.id === id);
      const cur = acc?.currency;
      if (isIso(cur)) return cur;
    }
    // Single-account fallback: id absent, or unmatched/invalid. The entity-detail reads
    // (get_campaign_details / get_adset_details) omit account_id, so most update-card
    // paths land here. If the workspace/token has EXACTLY ONE account, use its currency;
    // with 0 or 2+ accounts never guess → null (block the card).
    const only = list.length === 1 ? list[0]?.currency : undefined;
    return isIso(only) ? only : null;
  };
  const entity = async (kind: EntityKind, id: string | undefined): Promise<unknown> => {
    const eid = str(id);
    if (!eid) return null;
    const key = `${kind}:${eid}`;
    if (!entityCache.has(key)) {
      entityCache.set(key, Promise.resolve().then(() => provider.callRaw(DETAILS_TOOL[kind], { [ID_ARG[kind]]: eid })).catch(() => null));
    }
    return entityCache.get(key)!;
  };
  const entityName = async (kind: EntityKind, id: string | undefined): Promise<string | null> =>
    str(pick(await entity(kind, id), 'name')) ?? null;

  return { currencyForAccount, entity, entityName };
}

// ── shared bits ─────────────────────────────────────────────────────────────
const CREATE_PAUSED_TAIL = 'رح تبلّش موقوفة لحد ما تراجعيها وتشغّليها بإيدك — ما بتصرف ولا قرش قبل موافقتك.';
const CREATE_ACTIVE_TAIL = '⚠️ رح تبلّش شغّالة فوراً بعد موافقتك، فبتبدأ تصرف — تأكّدي قبل ما توافقي.';
const isPaused = (status: string | undefined): boolean => (status ?? 'PAUSED') !== 'ACTIVE';

// Format a budget arg (daily preferred over lifetime) against the account currency.
// Returns { phrase } on success, null when a budget IS present but currency can't be
// resolved (→ caller PLACEHOLDER), or { phrase: '' } when no budget field is present.
async function budgetPhrase(
  ctx: RenderCtx,
  a: Record<string, unknown>,
  accountId: string | undefined,
): Promise<{ phrase: string } | null> {
  const dMinor = toNum(a.daily_budget);
  const lMinor = toNum(a.lifetime_budget);
  if (dMinor == null && lMinor == null) return { phrase: '' };
  const cur = await ctx.currencyForAccount(accountId);
  if (!cur) return null;
  const isDaily = dMinor != null;
  const f = formatMinor(isDaily ? dMinor! : lMinor!, cur);
  if (!f) return null;
  return { phrase: `، ${isDaily ? 'بميزانية يومية' : 'بميزانية إجمالية'} ${f}` };
}

// Honest "you passed a name where I need an id" — shown on the card (NOT approvable).
// The measured failure: Salma passed campaign_name (she didn't know the id of the
// campaign she'd just created), so the entity lookup failed and the card went blank.
// This tells her exactly what's missing + how to resolve it herself (a read lookup).
function needId(what: string, idArg: string | undefined, nameHint: string | undefined, readTool: string): Rendered {
  const hint = idArg && !isMetaId(idArg) ? idArg : nameHint;
  return blocked(hint
    ? `يبدو إنك مرّرتِ اسم ${what} («${hint}») مش رقمها (id). لازم الرقم لأجهّز التعديل — دوّري عنه بـ${readTool} بالاسم، وبعدها اطلبي التعديل بالرقم.`
    : `ناقص رقم ${what} (id) — ما بقدر أجهّز التعديل بدونه.`);
}

// ── the 8 renderers ─────────────────────────────────────────────────────────
async function createCampaign(ctx: RenderCtx, a: Record<string, unknown>): Promise<Rendered> {
  const name = str(a.name);
  const objective = str(a.objective);
  if (!name || !objective) return PLACEHOLDER;
  const obj = OBJECTIVE_PHRASE[objective] ?? 'تحقّقلك الهدف اللي اخترتيه';
  const budget = await budgetPhrase(ctx, a, str(a.account_id));
  if (budget == null) return PLACEHOLDER; // budget present but currency unresolved
  const tail = isPaused(str(a.status)) ? CREATE_PAUSED_TAIL : CREATE_ACTIVE_TAIL;
  return ok(`رح أفتحلك «${name}» — حملة إعلانية جديدة هدفها ${obj}${budget.phrase}. ${tail}`);
}

async function createAdset(ctx: RenderCtx, a: Record<string, unknown>): Promise<Rendered> {
  const name = str(a.name);
  const goal = str(a.optimization_goal);
  if (!name || !goal) return PLACEHOLDER;
  const parentName = await ctx.entityName('campaign', str(a.campaign_id));
  const parent = parentName ? `جوّا «${parentName}»` : 'جوّا الحملة اللي اخترتيها';
  const goalPhrase = GOAL_PHRASE[goal] ? `مضبوطة ${GOAL_PHRASE[goal]}` : 'مضبوطة عالهدف اللي حدّدتيه';
  const billing = BILLING_PHRASE[str(a.billing_event) ?? ''] ?? '';
  const budget = await budgetPhrase(ctx, a, str(a.account_id));
  if (budget == null) return PLACEHOLDER;
  const tail = isPaused(str(a.status)) ? 'ورح تبلّش موقوفة لحد ما تشغّليها.' : '⚠️ ورح تبلّش شغّالة فوراً بعد موافقتك.';
  const mid = [goalPhrase, billing].filter(Boolean).join('، ');
  return ok(`رح أنشئلك مجموعة إعلانية جديدة اسمها «${name}»، ${parent}. ${mid}${budget.phrase}. ${tail}`);
}

async function createAd(ctx: RenderCtx, a: Record<string, unknown>): Promise<Rendered> {
  const name = str(a.name);
  if (!name) return PLACEHOLDER;
  const adsetName = await ctx.entityName('adset', str(a.adset_id));
  const creativeName = await ctx.entityName('creative', str(a.creative_id));
  const inAdset = adsetName ? `جوّا مجموعة «${adsetName}»` : 'جوّا المجموعة اللي اخترتيها';
  const withCreative = creativeName ? `ومربوط بـ«${creativeName}» (نفس التصميم اللي جهّزناه)` : 'ومربوط بالتصميم اللي اخترتيه';
  const tail = isPaused(str(a.status)) ? 'رح يبلّش موقوف لحد ما تراجعيه وتشغّليه بإيدك.' : '⚠️ رح يبلّش شغّال فوراً بعد موافقتك.';
  return ok(`رح أجهّزلك «${name}» ${inAdset}، ${withCreative}. ${tail}`);
}

async function createAdCreative(_ctx: RenderCtx, a: Record<string, unknown>): Promise<Rendered> {
  const name = str(a.name) ?? 'تصميم إعلان جديد';
  const message = str(a.message) ?? (Array.isArray(a.messages) ? str((a.messages as unknown[])[0]) : undefined);
  const headline = str(a.headline) ?? (Array.isArray(a.headlines) ? str((a.headlines as unknown[])[0]) : undefined);
  const desc = str(a.description);
  const cta = str(a.call_to_action_type);
  const link = str(a.link_url);
  const existingPost = str(a.object_story_id);
  const lines: string[] = [];
  if (message) lines.push(`• الكلام الرئيسي: ${message}`);
  if (headline) lines.push(`• العنوان: ${headline}`);
  if (desc) lines.push(`• الوصف: ${desc}`);
  if (cta) lines.push(`• الزر: «${CTA_PHRASE[cta] ?? cta}»${cta === 'BOOK_NOW' ? ' — بياخد الزبونة عصفحة الحجز عندك' : ''}`);
  if (link) lines.push(`• رابط الوجهة: ${link}`);
  if (existingPost && !lines.length) lines.push('• بيروّج منشور موجود عندك');
  if (!lines.length) return PLACEHOLDER; // nothing governable to show
  return ok(`رح أجهّزلك «${name}» — هيك رح يطلع الإعلان قدّام الناس:\n${lines.join('\n')}\nهاد بس التصميم — ما إلو ميزانية ولا بيصرف لحاله.`);
}

// Budget change → "من OLD إلى NEW — يعني زيادة/تخفيض DELTA". Needs currency (→
// PLACEHOLDER if unresolved). oldMinor best-effort: absent → "أضبط على NEW".
async function budgetChangeClause(
  ctx: RenderCtx, a: Record<string, unknown>, raw: unknown, label: string, unit: 'باليوم' | '',
): Promise<{ clause: string } | null | undefined> {
  const dMinor = toNum(a.daily_budget);
  const lMinor = toNum(a.lifetime_budget);
  if (dMinor == null && lMinor == null) return undefined; // no budget change
  const cur = await ctx.currencyForAccount(normAccountId(pick(raw, 'account_id')));
  if (!cur) return null; // budget change but currency unresolved → caller PLACEHOLDER
  const isDaily = dMinor != null;
  const newMinor = isDaily ? dMinor! : lMinor!;
  const newF = formatMinor(newMinor, cur);
  if (!newF) return null;
  const kind = isDaily ? 'اليومية' : 'الإجمالية';
  const oldMinor = toNum(pick(raw, isDaily ? 'daily_budget' : 'lifetime_budget'));
  if (oldMinor != null && oldMinor !== newMinor) {
    const oldF = formatMinor(oldMinor, cur);
    const deltaF = formatMinor(Math.abs(newMinor - oldMinor), cur);
    const dir = newMinor > oldMinor ? 'أرفعلك' : 'أنزّللك';
    const word = newMinor > oldMinor ? 'زيادة' : 'تخفيض';
    const delta = deltaF ? ` — يعني ${word} ${deltaF}${unit ? ` ${unit}` : ''}` : '';
    return { clause: `رح ${dir} الميزانية ${kind} لـ${label} من ${oldF} إلى ${newF}${delta}` };
  }
  return { clause: `رح أضبطلك الميزانية ${kind} لـ${label} على ${newF}` };
}

// The spend note for ACTIVATING an adset. Activation authorizes spend, so the card
// must state a real amount or BLOCK. Order: adset daily → adset lifetime → parent
// campaign daily → parent campaign lifetime. A POSITIVE amount is required at every
// step — Meta reports the unused budget field as the string "0", so "0" means "not
// this level", never a real US$0.00/day figure. Currency via currencyForAccount (its
// single-account fallback covers the account_id the entity reads omit). Returns a
// discriminated result: { note } to append, or { block } with the honest reason.
async function activationSpend(ctx: RenderCtx, raw: unknown): Promise<{ note: string } | { block: string }> {
  const cur = await ctx.currencyForAccount(normAccountId(pick(raw, 'account_id')));
  if (!cur) return { block: 'ما قدرت أحدد عملة الحساب الإعلاني، فما بعرض تأكيد تفعيل بدون رقم واضح.' };
  // Positive-amount gate + format in one step (closes over the resolved currency): the
  // "0" sentinel → null → falls through, so it never renders a false US$0.00 figure.
  const fmtPos = (v: unknown): string | null => {
    const n = toNum(v);
    return n != null && n > 0 ? formatMinor(n, cur) : null;
  };
  let f = fmtPos(pick(raw, 'daily_budget'));
  if (f) return { note: `، وتبدأ تصرف من ميزانيتها اليومية (${f} باليوم)` };
  f = fmtPos(pick(raw, 'lifetime_budget'));
  if (f) return { note: `، وتبدأ تصرف من ميزانيتها الإجمالية (${f})` };
  // CBO adset: the budget lives on the parent campaign (one memoized fetch).
  const campRaw = await ctx.entity('campaign', str(pick(raw, 'campaign_id')));
  f = fmtPos(pick(campRaw, 'daily_budget'));
  if (f) return { note: `، وتبدأ تصرف من ميزانية الحملة اليومية (${f} باليوم)` };
  f = fmtPos(pick(campRaw, 'lifetime_budget'));
  if (f) return { note: `، وتبدأ تصرف من ميزانية الحملة الإجمالية (${f})` };
  return { block: 'ما في ميزانية محدّدة لهالمجموعة ولا لحملتها. حدّدي ميزانية من مدير إعلانات ميتا قبل ما نفعّلها.' };
}

async function updateCampaign(ctx: RenderCtx, a: Record<string, unknown>): Promise<Rendered> {
  const idArg = str(a.campaign_id);
  if (!isMetaId(idArg)) return needId('الحملة', idArg, str(a.campaign_name) ?? str(a.name), 'get_campaigns');
  const raw = await ctx.entity('campaign', idArg);
  if (!raw) return blocked(`ما لقيت حملة بالرقم «${idArg}» — تأكّدي من رقم الحملة (id) وجرّبي كمان مرة.`);
  const name = str(pick(raw, 'name'));
  const label = name ? `«${name}»` : 'الحملة';
  const clauses: string[] = [];
  const budget = await budgetChangeClause(ctx, a, raw, label, 'باليوم');
  if (budget === null) return PLACEHOLDER;
  if (budget) clauses.push(budget.clause);
  const newStatus = str(a.status);
  if (newStatus === 'PAUSED') clauses.push(`رح أوقّف ${label}`);
  else if (newStatus === 'ACTIVE') clauses.push(`رح أشغّل ${label}`);
  const newName = str(a.name);
  if (newName && newName !== name) clauses.push(`رح أغيّر اسم الحملة لـ«${newName}»`);
  if (!clauses.length) return PLACEHOLDER; // only advanced fields we don't describe yet
  return ok(`${clauses.join('، و')}. باقي إعدادات الحملة رح تضل متل ما هي.`);
}

async function updateAdset(ctx: RenderCtx, a: Record<string, unknown>): Promise<Rendered> {
  const idArg = str(a.adset_id);
  if (!isMetaId(idArg)) return needId('المجموعة الإعلانية', idArg, str(a.adset_name) ?? str(a.name), 'get_adsets');
  const raw = await ctx.entity('adset', idArg);
  if (!raw) return blocked(`ما لقيت مجموعة إعلانية بالرقم «${idArg}» — تأكّدي من الرقم (id) وجرّبي كمان مرة.`);
  const name = str(pick(raw, 'name'));
  const label = name ? `مجموعة «${name}»` : 'المجموعة الإعلانية';
  const curStatus = str(pick(raw, 'status', 'effective_status', 'configured_status'));
  const clauses: string[] = [];
  const newStatus = str(a.status);
  if (newStatus === 'ACTIVE') {
    const was = curStatus && curStatus !== 'ACTIVE' ? ' (هلّق موقوفة)' : '';
    // Activation authorizes spend → state a real amount (adset budget, or the parent
    // campaign's for a CBO adset) or BLOCK; never a "reaches people" card with no figure.
    const spend = await activationSpend(ctx, raw);
    if ('block' in spend) return blocked(spend.block);
    clauses.push(`رح أشغّل ${label}${was}. أول ما توافقي رح تبلّش تشتغل، يوصل إعلانها للناس${spend.note}`);
  } else if (newStatus === 'PAUSED') {
    const was = curStatus === 'ACTIVE' ? ' (هلّق شغّالة)' : '';
    clauses.push(`رح أوقّف ${label}${was}. أول ما توافقي رح تبطّل تظهر وتبطّل تصرف، بس بتضل موجودة وتقدري ترجّعي تشغّليها`);
  }
  const budget = await budgetChangeClause(ctx, a, raw, label, 'باليوم');
  if (budget === null) return PLACEHOLDER;
  if (budget) clauses.push(budget.clause);
  const newName = str(a.name);
  if (newName && newName !== name) clauses.push(`رح أغيّر اسم المجموعة لـ«${newName}»`);
  if (!clauses.length) return PLACEHOLDER;
  return ok(`${clauses.join('، و')}.`);
}

async function updateAd(ctx: RenderCtx, a: Record<string, unknown>): Promise<Rendered> {
  const idArg = str(a.ad_id);
  if (!isMetaId(idArg)) return needId('الإعلان', idArg, str(a.ad_name) ?? str(a.name), 'get_ads');
  const raw = await ctx.entity('ad', idArg);
  if (!raw) return blocked(`ما لقيت إعلان بالرقم «${idArg}» — تأكّدي من الرقم (id) وجرّبي كمان مرة.`);
  const name = str(pick(raw, 'name'));
  const label = name ? `«${name}»` : 'الإعلان';
  const curStatus = str(pick(raw, 'status', 'effective_status', 'configured_status'));
  const clauses: string[] = [];
  const newStatus = str(a.status);
  if (newStatus === 'PAUSED') {
    const was = curStatus === 'ACTIVE' ? ' (هلّق شغّال)' : '';
    clauses.push(`رح أوقّف ${label}${was}. أول ما توافقي رح يبطّل يظهر للناس ويبطّل يصرف، بس بيضل موجود وتقدري ترجّعي تشغّليه بأي وقت`);
  } else if (newStatus === 'ACTIVE') {
    const was = curStatus && curStatus !== 'ACTIVE' ? ' (هلّق موقوف)' : '';
    clauses.push(`رح أشغّل ${label}${was}. أول ما توافقي رح يبلّش يظهر للناس ويبدأ يصرف من ميزانية مجموعته`);
  }
  const newName = str(a.name);
  if (newName && newName !== name) clauses.push(`رح أغيّر اسم الإعلان لـ«${newName}»`);
  if (str(a.creative_id)) {
    const cName = await ctx.entityName('creative', str(a.creative_id));
    clauses.push(cName ? `رح أبدّل تصميمه لـ«${cName}»` : 'رح أبدّل تصميمه للتصميم اللي اخترتيه');
  }
  if (!clauses.length) return PLACEHOLDER;
  return ok(`${clauses.join('، و')}.`);
}

async function bulkUpdateAds(ctx: RenderCtx, a: Record<string, unknown>): Promise<Rendered> {
  const explicit = Array.isArray(a.ad_updates) ? (a.ad_updates as Record<string, unknown>[]) : null;
  const filter = a.filter && typeof a.filter === 'object' ? (a.filter as Record<string, unknown>) : null;
  const updates = a.updates && typeof a.updates === 'object' ? (a.updates as Record<string, unknown>) : null;

  const stopTail = 'أول ما توافقي رح يبطّلوا كلهم يظهروا ويبطّلوا يصرفوا، وبيضلوا موجودين وتقدري ترجّعي تشغّليهم وقت ما بدّك';
  const goTail = 'أول ما توافقي رح يبلّشوا كلهم يظهروا ويبدأوا يصرفوا';
  const noun = (n: number) => (n >= 3 && n <= 10 ? 'إعلانات' : 'إعلان');

  // Explicit mode: exact count from the list; describe the change only if uniform.
  if (explicit) {
    const statuses = new Set(explicit.map((u) => str(u?.status)).filter(Boolean));
    const count = explicit.length;
    if (statuses.size === 1) {
      const st = [...statuses][0];
      if (st === 'PAUSED') return ok(`رح أوقّف ${count} ${noun(count)} دفعة وحدة. ${stopTail}.`);
      if (st === 'ACTIVE') return ok(`رح أشغّل ${count} ${noun(count)} دفعة وحدة. ${goTail}.`);
    }
    const names = explicit.filter((u) => str(u?.name)).length;
    if (names === count && count > 0) return ok(`رح أغيّر أسماء ${count} ${noun(count)} دفعة وحدة.`);
    return PLACEHOLDER; // bid changes / mixed updates → not described yet
  }

  // Filter mode: describe the scope + the change. Count is DEFERRED (a firm count
  // needs a filter-preview read); we show the scope honestly instead of a fake number.
  if (filter && updates) {
    const st = str(updates.status);
    const verb = st === 'PAUSED' ? 'رح أوقّف' : st === 'ACTIVE' ? 'رح أشغّل' : '';
    if (!verb) return PLACEHOLDER; // non-status bulk (bid/name/creative) → not described yet
    const fStatus = str(filter.status);
    const scope = fStatus === 'ACTIVE' ? 'الشغّالة' : fStatus === 'PAUSED' ? 'الموقوفة' : '';
    let where = '';
    const campName = await ctx.entityName('campaign', str(filter.campaign_id));
    if (campName) where = ` جوّا «${campName}»`;
    else if (str(filter.name_contains)) where = ` اللي باسمها «${str(filter.name_contains)}»`;
    const tail = st === 'PAUSED' ? stopTail : goTail;
    return ok(`${verb} كل الإعلانات ${scope}${where} دفعة وحدة. ${tail}.`.replace('  ', ' '));
  }
  return PLACEHOLDER;
}

/**
 * Render one gated proposal. Returns isPlaceholder=true (→ NOT approvable) for any
 * tool without a renderer, any amount whose currency can't be resolved, a failed
 * entity read, or a missing summary-critical arg. NEVER throws — any unexpected error
 * degrades to PLACEHOLDER so the gate loop never retries/re-mints on a render failure.
 * `shownArgs` MUST be the REDACTED args (no PII in the summary/card/audit).
 */
export async function renderAction(ctx: RenderCtx, tool: string, shownArgs: Record<string, unknown>): Promise<Rendered> {
  const a = shownArgs ?? {};
  try {
    switch (tool) {
      case 'create_campaign': return await createCampaign(ctx, a);
      case 'create_adset': return await createAdset(ctx, a);
      case 'create_ad': return await createAd(ctx, a);
      case 'create_ad_creative': return await createAdCreative(ctx, a);
      case 'update_campaign': return await updateCampaign(ctx, a);
      case 'update_adset': return await updateAdset(ctx, a);
      case 'update_ad': return await updateAd(ctx, a);
      case 'bulk_update_ads': return await bulkUpdateAds(ctx, a);
      default: return PLACEHOLDER; // no renderer → placeholder → not approvable
    }
  } catch {
    return PLACEHOLDER;
  }
}
