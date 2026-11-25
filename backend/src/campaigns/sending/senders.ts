import type { ZernioClient, ZernioWhatsAppTemplate } from "../../integrations/zernio.client";
import { campaignError } from "../campaign-errors";
import { type BudgetBucket, budgeted } from "./zernio-budget";

/**
 * SP-13 sending numbers. A campaign names its senders in
 * `Campaign.senderChannelIds` ([0] is the primary); `senderChannelId` always
 * mirrors the primary so `main` and the SP-12 code read the right number.
 */

/**
 * The campaign's senders: `senderChannelIds` when non-empty, else the legacy
 * `[senderChannelId]`, else `[]`, which means "the default Zernio WhatsApp
 * number" (resolved by `campaignSender(prisma, ws, null)`).
 */
export function effectiveSenderIds(campaign: {
  senderChannelIds?: readonly string[] | null;
  senderChannelId?: string | null;
}): string[] {
  if (campaign.senderChannelIds && campaign.senderChannelIds.length > 0) return [...campaign.senderChannelIds];
  return campaign.senderChannelId ? [campaign.senderChannelId] : [];
}

/** Round-robin: the sender of the `index`-th reachable recipient (contact-id order). */
export function assignSender<T>(index: number, senders: readonly T[]): T {
  return senders[index % senders.length];
}

/**
 * Recipients per sender for `n` reachable recipients, in sender order: the
 * closed form `ceil((n - i) / k)` for sender `i` of `k`, which equals
 * counting `assignSender` over 0..n-1 (proved by the spec).
 */
export function splitCounts(n: number, senders: readonly unknown[]): number[] {
  const k = senders.length;
  return senders.map((_, i) => Math.max(0, Math.ceil((n - i) / k)));
}

interface CopyShape {
  header: { format: string; text: string | null } | null;
  body: string | null;
  footer: string | null;
  buttons: Array<{ type: string; text: string }>;
}

function shapeOf(t: Pick<ZernioWhatsAppTemplate, "components">): CopyShape {
  const out: CopyShape = { header: null, body: null, footer: null, buttons: [] };
  for (const c of t.components ?? []) {
    const type = String(c.type ?? "").toUpperCase();
    const text = typeof c.text === "string" ? c.text : null;
    if (type === "HEADER") {
      const format = String(c.format ?? "TEXT").toUpperCase();
      out.header = { format, text: format === "TEXT" ? text : null };
    } else if (type === "BODY") out.body = text;
    else if (type === "FOOTER") out.footer = text;
    else if (type === "BUTTONS" && Array.isArray(c.buttons)) {
      out.buttons = (c.buttons as Array<Record<string, unknown>>).map((b) => ({
        type: String(b.type ?? "").toUpperCase(),
        text: String(b.text ?? ""),
      }));
    }
  }
  return out;
}

/**
 * Two approved copies send the same message: body text, header format (and
 * text for a text header), footer, and button types and texts, in order
 * (Tkana's rule). Ids, categories and sample values do not matter.
 */
export function sameTemplateCopy(
  a: Pick<ZernioWhatsAppTemplate, "components">,
  b: Pick<ZernioWhatsAppTemplate, "components">,
): boolean {
  return JSON.stringify(shapeOf(a)) === JSON.stringify(shapeOf(b));
}

const baseLang = (l: string | null | undefined) => String(l ?? "").split(/[_-]/)[0].toLowerCase();

/** The approved copy of `template` in one account's list (exact language first). */
function approvedCopy(list: ZernioWhatsAppTemplate[], template: { name: string; lang: string }): ZernioWhatsAppTemplate | null {
  const hits = list.filter(
    (t) => t.name === template.name && String(t.status ?? "").toUpperCase() === "APPROVED" && baseLang(t.language) === baseLang(template.lang),
  );
  return hits.find((t) => t.language === template.lang) ?? hits[0] ?? null;
}

/** SP-14: a sender whose copy of the template is paused or disabled. */
export interface PausedCopy {
  channelId: string;
  status: "paused" | "disabled";
}

/** The paused or disabled copy of `template` in one account's list (used when it holds no approved one). */
function pausedCopy(list: ZernioWhatsAppTemplate[], template: { name: string; lang: string }): "paused" | "disabled" | null {
  const hits = list.filter((t) => t.name === template.name && baseLang(t.language) === baseLang(template.lang));
  const statuses = hits.map((t) => String(t.status ?? "").toUpperCase());
  if (statuses.includes("DISABLED")) return "disabled";
  if (statuses.includes("PAUSED")) return "paused";
  return null;
}

/**
 * Which senders lack the campaign's template (ruling 4). Reads each distinct
 * account's approved templates once (read-only GET). A sender is `missing`
 * when it holds no APPROVED copy with the same name and base language, or a
 * copy that differs from the primary's (`sameTemplateCopy`). When the
 * primary's copy is missing or unreadable, the others are judged by
 * presence alone. `failed` lists senders whose account could not be read
 * (launch fails closed on them: 502 campaigns.template_check_failed).
 * Returns channel ids. With `opts.budget` (SP-13 final review, R19) each
 * account read takes a token from the shared campaign bucket, and a 429
 * pauses it.
 *
 * SP-14 (ruling 10): a sender with no approved copy but a PAUSED or
 * DISABLED one (same name and base language) is listed in `paused` with
 * its status, not in `missing`. Launch refuses it with
 * `campaigns.template_paused_on_number`, after `template_check_failed` and
 * before `template_missing_on_number`. This live read stays the authority;
 * the health snapshot never authorizes a send.
 */
export async function templateOnSenders(
  zernio: Pick<ZernioClient, "whatsappTemplates">,
  senders: ReadonlyArray<{ channelId: string | null; accountId: string }>,
  template: { name: string; lang: string },
  opts: { budget?: BudgetBucket } = {},
): Promise<{ missing: string[]; failed: string[]; paused: PausedCopy[] }> {
  const read = (accountId: string) =>
    opts.budget ? budgeted(opts.budget, () => zernio.whatsappTemplates(accountId)) : zernio.whatsappTemplates(accountId);
  const reads = new Map<string, Promise<ZernioWhatsAppTemplate[] | Error>>();
  for (const s of senders) {
    if (!reads.has(s.accountId)) {
      reads.set(
        s.accountId,
        read(s.accountId).then(
          (l) => l ?? [],
          (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
        ),
      );
    }
  }
  const lists = new Map<string, ZernioWhatsAppTemplate[] | Error>();
  for (const [acc, p] of reads) lists.set(acc, await p);

  const missing: string[] = [];
  const failed: string[] = [];
  const paused: PausedCopy[] = [];
  let reference: ZernioWhatsAppTemplate | null = null;
  senders.forEach((s, i) => {
    const id = s.channelId ?? s.accountId;
    const list = lists.get(s.accountId);
    if (!list || list instanceof Error) {
      failed.push(id);
      return;
    }
    const found = approvedCopy(list, template);
    if (i === 0) reference = found;
    if (!found) {
      const blocked = pausedCopy(list, template);
      if (blocked) paused.push({ channelId: id, status: blocked });
      else missing.push(id);
      return;
    }
    if (i > 0 && reference && !sameTemplateCopy(reference, found)) missing.push(id);
  });
  return { missing, failed, paused };
}

/**
 * Create/update sender fields → what to store, or null when neither was
 * given (no change). Only `senderChannelId`: `[id]` or `[]`. Only the array:
 * duplicates removed (first kept), primary = [0]. Both: they must agree
 * (`senderChannelIds[0] === senderChannelId`), else 400
 * `campaigns.sender_conflict`. `senderChannelId` is always `ids[0] ?? null`.
 */
export function normalizeSenderWrite(dto: {
  senderChannelIds?: readonly string[] | null;
  senderChannelId?: string | null;
}): { senderChannelIds: string[]; senderChannelId: string | null } | null {
  const hasArray = Array.isArray(dto.senderChannelIds);
  const hasLegacy = dto.senderChannelId !== undefined;
  if (!hasArray && !hasLegacy) return null;
  const ids = hasArray ? [...new Set(dto.senderChannelIds as string[])] : dto.senderChannelId ? [dto.senderChannelId] : [];
  if (hasArray && hasLegacy && (ids[0] ?? null) !== (dto.senderChannelId ?? null)) {
    throw campaignError("campaigns.sender_conflict");
  }
  return { senderChannelIds: ids, senderChannelId: ids[0] ?? null };
}
