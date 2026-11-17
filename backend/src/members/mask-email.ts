/**
 * SP-26: an email shown to someone who is not (yet) its owner, or kept in an
 * audit row about a non-member: the first letter of the local part, the rest
 * masked, the domain kept. `nora@example.com` → `n***@example.com`.
 * Mirrored by the frontend's `src/auth/maskEmail.ts` (a test pins both).
 */
export function maskEmail(email: string): string {
  const e = (email ?? "").trim();
  const at = e.lastIndexOf("@");
  if (at <= 0) return "***";
  return `${e[0]}***${e.slice(at)}`;
}
