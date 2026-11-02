import { PAYMENT_OVERDUE } from "@/lib/paymentLock";

export type TiremallExchange =
  | { kind: "ok"; accessToken: string }
  | { kind: "payment_overdue" }
  | { kind: "failed" };

/** Trade the one-time Tiremall token for a CRM session (pre-React boot path). */
export async function exchangeTiremallSso(
  token: string,
  apiBase: string,
  doFetch: typeof fetch = fetch,
): Promise<TiremallExchange> {
  try {
    const res = await doFetch(`${apiBase}/auth/sso/tiremall`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { code?: unknown } | null;
      return res.status === 403 && body?.code === PAYMENT_OVERDUE
        ? { kind: "payment_overdue" }
        : { kind: "failed" };
    }
    const json = (await res.json()) as { accessToken?: string };
    return json.accessToken ? { kind: "ok", accessToken: json.accessToken } : { kind: "failed" };
  } catch {
    return { kind: "failed" };
  }
}
