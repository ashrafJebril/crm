/**
 * PII redaction for DURABLE stores (AdsActionAudit rows + the operational
 * resultJson) — and the seed of STEP 6's response-side denylist. Field-NAME based,
 * recursive, tool-aware, and it FAILS TOWARD REDACTION: over-redacting loses a
 * detail; under-redacting durably stores a customer's phone number.
 *
 * NOT applied to AdsPendingAction.argsJson: the execute path sends those exact
 * bytes to Meta and the action hash binds them — redacting there would break both.
 */

// Exact key names known to carry personal data in Meta payloads.
const PII_EXACT = new Set([
  'field_data', // lead-form submissions — the ENTIRE answer set (name/phone/email)
  'lead_data',
  'whatsapp_number',
  'contact_data',
  'customer_info',
  'user_data', // conversion-event uploads (hashed, but treat as PII regardless)
  'invalid_entry_samples', // add_users_to_audience RESULT — echoes raw rejected rows
]);

// Key families: any key whose lowercased name CONTAINS one of these is redacted.
const PII_FAMILIES = ['phone', 'email'];

// Tools whose args carry BULK customer PII under otherwise-benign key names
// (positional string arrays), which field-name redaction alone cannot see. For
// these, the listed keys are redacted wholesale in the audit copy.
const PII_HEAVY_TOOL_KEYS: Record<string, string[]> = {
  add_users_to_audience: ['data', 'users', 'payload'],
  remove_users_from_audience: ['data', 'users', 'payload'],
  upload_conversion_events: ['data', 'events', 'user_data'],
};

const REDACTED = '[REDACTED]';
const MAX_DEPTH = 8;

function isPiiKey(key: string): boolean {
  const k = key.toLowerCase();
  if (PII_EXACT.has(k)) return true;
  return PII_FAMILIES.some((f) => k.includes(f));
}

/** Deep copy with PII-named fields replaced by '[REDACTED]'. Never mutates input.
 *  Uses null-prototype accumulators so a literal '__proto__' key is treated as a
 *  normal own property, never a prototype write. */
export function redactPii(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return REDACTED; // over-deep → refuse to inspect, redact
  if (Array.isArray(value)) return value.map((v) => redactPii(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = Object.create(null);
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isPiiKey(k) ? REDACTED : redactPii(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Audit-copy redaction that ALSO nulls a PII-heavy tool's bulk-data keys, which
 *  hide raw customer rows under benign names (`data`) that field-name redaction
 *  can't catch. */
export function redactArgsForTool(tool: string, args: unknown): unknown {
  const base = redactPii(args);
  const heavyKeys = PII_HEAVY_TOOL_KEYS[tool];
  if (heavyKeys && base && typeof base === 'object' && !Array.isArray(base)) {
    const out: Record<string, unknown> = Object.create(null);
    for (const [k, v] of Object.entries(base as Record<string, unknown>)) {
      out[k] = heavyKeys.includes(k) ? REDACTED : v;
    }
    return out;
  }
  return base;
}

// Value-level scrub for FREE TEXT (provider error messages), which routinely echo
// the offending email/phone. Key-based redaction can't help a flat string.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const LONG_DIGITS_RE = /[+\d][\d\s().-]{7,}\d/g; // phone-ish runs (8+ digits w/ separators)

export function scrubText(text: string): string {
  return text.replace(EMAIL_RE, '[EMAIL]').replace(LONG_DIGITS_RE, '[NUMBER]');
}
