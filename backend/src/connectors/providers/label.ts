/** Pulls a short account label (name or email) out of a probe's MCP content. */
export function labelFromContent(content: unknown[], keys: readonly string[]): string | null {
  for (const block of content) {
    const text = (block as { type?: unknown; text?: unknown })?.type === "text" ? (block as { text: string }).text : null;
    if (typeof text !== "string") continue;
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      continue;
    }
    const found = find(data, keys, 0);
    if (found) return found.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120) || null;
  }
  return null;
}

function find(v: unknown, keys: readonly string[], depth: number): string | null {
  if (!v || typeof v !== "object" || depth > 4) return null;
  const o = v as Record<string, unknown>;
  for (const k of keys) if (typeof o[k] === "string" && o[k]) return o[k] as string;
  for (const child of Object.values(o)) {
    const hit = find(child, keys, depth + 1);
    if (hit) return hit;
  }
  return null;
}
