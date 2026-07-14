/**
 * Resolve the JWT signing secret, failing fast if it is missing.
 *
 * Previously the code fell back to a hardcoded dev secret
 * ("tkana-dev-secret-change-in-prod"). In any environment where JWT_SECRET
 * was left unset, that well-known string signed real tokens — so anyone could
 * forge a token with `isSuperAdmin:true` and take over every workspace.
 *
 * We now throw at module load. Set JWT_SECRET in the environment (a long
 * random string; see backend/.env). This runs before the HTTP server binds,
 * so a misconfigured deploy crashes loudly instead of booting insecure.
 */
export function requireJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "JWT_SECRET is not set (or is shorter than 32 chars). Refusing to start with a weak/absent JWT secret. Set a long random JWT_SECRET in the environment.",
    );
  }
  return secret;
}
