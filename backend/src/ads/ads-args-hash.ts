import { createHash } from 'node:crypto';

// Deterministic canonical form: recursively key-sorted objects, arrays in order.
// The accumulator is a NULL-PROTOTYPE object so a literal '__proto__' key becomes
// a normal own property (included in the hash) instead of a silent prototype
// write that would drop it — without this, a __proto__-keyed field injected into
// a stored row would be invisible to the hash yet still serialized to the provider.
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const acc: Record<string, unknown> = Object.create(null);
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      acc[k] = canonical((v as Record<string, unknown>)[k]);
    }
    return acc;
  }
  return v;
}

/**
 * sha256 of the canonicalized {tool, args, summary} triple. Computed by the gate at
 * PROPOSE time and re-computed by the approve endpoint at EXECUTE time: if the stored
 * tool/args/summary no longer hash to the stored value, the row was tampered with
 * between propose and approve and execution is refused. Binding the TOOL (not just
 * args) is deliberate — the tool name is part of "what hits Meta", so a tool-only
 * swap that leaves args valid must not pass. STEP 5 EXTENDED the seal to include the
 * rendered SUMMARY: the exact text the owner approved on is now sealed to the {tool,
 * args} that execute, so the card can't show summary A while a tampered row executes
 * B. Bound for ALL proposals (placeholder summaries too) so the seal is uniform.
 * NOTE: this is a CONSISTENCY seal (detects a mutated row / cross-row swap / partial
 * write), NOT a cryptographic one — an attacker with full DB write could recompute
 * it; HMAC-with-secret is the upgrade if that threat is in scope.
 */
export function hashAction(tool: string, args: unknown, summary: string): string {
  return createHash('sha256').update(JSON.stringify(canonical({ tool, args, summary }))).digest('hex');
}
