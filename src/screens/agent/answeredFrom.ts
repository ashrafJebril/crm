/**
 * SP-20 "Answered from" (pure): the knowledge sources behind a sandbox reply.
 * ANSWERED_FROM_VISIBLE shown, then "+N"; only http(s) URLs become links.
 */
import type { SandboxSource } from "@/lib/types";
import { ANSWERED_FROM_VISIBLE } from "./agentConstants";

export interface AnsweredFrom {
  visible: { sourceId: string; title: string; href: string | null }[];
  more: number;
}

export function safeHref(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export function answeredFrom(sources: SandboxSource[] | undefined): AnsweredFrom {
  const seen = new Set<string>();
  const unique = (sources ?? []).filter((s) => (seen.has(s.sourceId) ? false : (seen.add(s.sourceId), true)));
  return {
    visible: unique.slice(0, ANSWERED_FROM_VISIBLE).map((s) => ({ sourceId: s.sourceId, title: s.title || s.sourceId, href: safeHref(s.url) })),
    more: Math.max(0, unique.length - ANSWERED_FROM_VISIBLE),
  };
}
