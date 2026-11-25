// Pure helpers for turning CRM contacts into a WhatsApp broadcast audience.

/** Minimum/maximum digits in an international number (E.164 allows up to 15). */
const MIN_DIGITS = 8;
const MAX_DIGITS = 15;

/**
 * E.164 ("+962790000001") or null. Contacts are stored with country codes
 * (WhatsApp ids are digits with the country code), so a local number with a
 * leading 0 is rejected rather than guessed into the wrong country.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) digits = digits.slice(1);
  else if (digits.startsWith("00")) digits = digits.slice(2);
  else if (digits.startsWith("0")) return null;
  if (!/^\d+$/.test(digits)) return null;
  if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) return null;
  return `+${digits}`;
}

export interface AudienceContact {
  /** The contact id (SP-12 snapshots it on the recipient row). Always selected at launch. */
  id?: string;
  name: string;
  phone: string | null;
  lifecycle: string;
  marketingOptOut?: boolean;
}

export interface CampaignRecipient {
  contactId?: string;
  name: string;
  phone: string;
}

/** SP-12: an audience member left out at launch, written as a `skipped` row. */
export interface SkippedRecipient {
  contactId?: string;
  name: string;
  /** E.164 when the number was usable, else null. */
  phone: string | null;
  reason: "opted_out" | "no_phone";
}

export interface SkippedCounts {
  noPhone: number;
  optedOut: number;
  duplicate: number;
}

/**
 * Who a campaign can actually reach. "churned" is what an HJZ opt-out or
 * deletion sets, so those contacts never get marketing.
 *
 * SP-13: `seen` carries the duplicate-phone set across keyset pages when
 * the audience is streamed (a fresh set per call by default).
 */
export function buildRecipients(contacts: AudienceContact[], seen: Set<string> = new Set<string>()): {
  recipients: CampaignRecipient[];
  skipped: SkippedCounts;
  /** Opted-out and phoneless members (duplicates get no row, ruling 11). */
  skippedRows: SkippedRecipient[];
} {
  const recipients: CampaignRecipient[] = [];
  const skippedRows: SkippedRecipient[] = [];
  const skipped: SkippedCounts = { noPhone: 0, optedOut: 0, duplicate: 0 };
  for (const c of contacts) {
    const phone = normalizePhone(c.phone);
    if (c.lifecycle?.toLowerCase() === "churned" || c.marketingOptOut === true) {
      skipped.optedOut++;
      skippedRows.push({ contactId: c.id, name: c.name, phone, reason: "opted_out" });
      continue;
    }
    if (!phone) {
      skipped.noPhone++;
      skippedRows.push({ contactId: c.id, name: c.name, phone: null, reason: "no_phone" });
      continue;
    }
    if (seen.has(phone)) {
      skipped.duplicate++;
      continue;
    }
    seen.add(phone);
    recipients.push({ contactId: c.id, name: c.name.trim() || "Customer", phone });
  }
  return { recipients, skipped, skippedRows };
}

export const totalSkipped = (s: SkippedCounts) => s.noPhone + s.optedOut + s.duplicate;

/**
 * Meta's marketing-template list price (USD per message) by country calling
 * code, effective 1 Oct 2026 (zernio.com/whatsapp-api-pricing). Meta bills
 * these to the workspace's own WhatsApp Business Account, not to us.
 */
const MARKETING_RATE_USD: Array<[prefix: string, rate: number]> = [
  ["966", 0.0576], // Saudi Arabia
  ["971", 0.0576], // UAE
  ["962", 0.0392], // Jordan (Rest of Middle East)
  ["964", 0.0392], // Iraq
  ["965", 0.0392], // Kuwait
  ["968", 0.0392], // Oman
  ["970", 0.0392], // Palestine
  ["973", 0.0392], // Bahrain
  ["974", 0.0392], // Qatar
  ["961", 0.0392], // Lebanon
];

/** Rough Meta cost of a campaign. Numbers outside the table are counted, not priced. */
export function estimateMetaCost(phones: string[]): { usd: number; unpriced: number } {
  let usd = 0;
  let unpriced = 0;
  for (const p of phones) {
    const digits = p.replace(/^\+/, "");
    const hit = MARKETING_RATE_USD.find(([prefix]) => digits.startsWith(prefix));
    if (hit) usd += hit[1];
    else unpriced++;
  }
  return { usd, unpriced };
}

export type CampaignStatus = "draft" | "scheduled" | "running" | "completed" | "failed" | "cancelled";

/** Zernio broadcast status → campaign status. Unknown values mean it is still going. */
export function campaignStatusFor(zernioStatus: string): CampaignStatus {
  switch (zernioStatus) {
    case "draft":
      return "draft";
    case "scheduled":
      return "scheduled";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "running";
  }
}

/** Highest {{n}} placeholder in a template body. */
export function templatePlaceholderCount(body: string | null | undefined): number {
  let max = 0;
  for (const m of (body ?? "").matchAll(/\{\{\s*(\d+)\s*\}\}/g)) max = Math.max(max, Number(m[1]));
  return max;
}

/** Split into fixed-size batches (Zernio: 1,000 contacts / 100 recipients per call). */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
