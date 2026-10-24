/**
 * Where HJZ's inbound CRM-sync routes live. HJZ_API_URL is HJZ's API base
 * (e.g. http://127.0.0.1:3030/api/v1). Older deployments only set
 * HJZ_OUTBOUND_URL to the full segments route, so the base is derived from it.
 */
export type HjzWebhookKind = "clients" | "segments" | "appointments";

export function hjzWebhookUrl(kind: HjzWebhookKind): string | null {
  const base =
    process.env.HJZ_API_URL?.trim().replace(/\/+$/, "") ||
    process.env.HJZ_OUTBOUND_URL?.trim().replace(/\/webhooks\/marketing\/segments\/?$/, "");
  if (!base || !process.env.HJZ_WEBHOOK_SECRET) return null;
  return `${base}/webhooks/marketing/${kind}`;
}

export async function postToHjz(
  kind: HjzWebhookKind,
  payload: unknown,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const url = hjzWebhookUrl(kind);
  if (!url) return { ok: false, status: 0, body: null };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-marketing-secret": process.env.HJZ_WEBHOOK_SECRET!,
    },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body };
}
