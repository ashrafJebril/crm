/**
 * A test turn arriving over MCP. l's `dry_run` (the "Try your agent" panel
 * running the real agent) sends `X-Kewy-Dry-Run: 1` on every MCP request;
 * our own SP-20 sandbox sends `X-Dry-Run: 1` to the connector proxy. Either
 * one means: run reads, refuse or mock every write.
 *
 * Only the exact value "1" counts, so a stray header value never turns a
 * live turn into a test (or the reverse).
 */
export const L_DRY_RUN_HEADER = "x-kewy-dry-run";
export const SANDBOX_DRY_RUN_HEADER = "x-dry-run";

export function isDryRun(...values: (string | string[] | undefined)[]): boolean {
  return values.some((v) => (Array.isArray(v) ? v.includes("1") : v === "1"));
}
