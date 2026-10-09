/**
 * CRM workspaceId -> kewy-ai tenantId.
 *
 * Today these are the same string (the live salon is cmpayevw8000011v0tgyu6rz1
 * in both systems), which is exactly why this function exists rather than the
 * value being passed straight through: the identity is a coincidence of how the
 * tenant was provisioned, not a contract. When kewy-ai is sold to a workspace
 * that was created separately, this becomes a lookup and every call site is
 * already routed through it.
 *
 * Lives in its own file so the knowledge proxy and the AI settings proxy share
 * ONE mapping. A second copy is how the two surfaces would eventually disagree
 * about which salon a request belongs to.
 */
export function tenantIdFor(workspaceId: string): string {
  return workspaceId;
}
