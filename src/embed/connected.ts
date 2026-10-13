import type { QueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";

/** Drop every cached `/integrations…` query so status cards refetch. */
export function invalidateIntegrations(qc: QueryClient): void {
  void qc.invalidateQueries({
    predicate: (q) =>
      typeof q.queryKey[0] === "string" && (q.queryKey[0] as string).startsWith("/integrations"),
  });
}

export interface RefreshDeps {
  post?: (path: string) => Promise<unknown>;
  invalidate: () => void;
}

/**
 * Embed frame received `kewy:connected` from the connect popup. For Zernio the
 * popup never mounted the app, so ZernioRedirectCapture's sync never ran —
 * run the same (idempotent) sync here, then invalidate. A failed sync still
 * invalidates so the cards reflect whatever the backend has.
 */
export async function refreshAfterConnect(provider: string, deps: RefreshDeps): Promise<void> {
  const post = deps.post ?? ((path: string) => api.post(path));
  if (provider === "zernio") {
    try {
      await post("/integrations/zernio/sync");
    } catch {
      /* fall through to invalidate */
    }
  }
  deps.invalidate();
}
