/**
 * SP-21 robots.txt (R8, Review Focus 1). Pure.
 *
 * Groups are read for our agent token (`KewyKnowledgeBot`), else `*`. Within
 * the chosen group the longest matching `Allow`/`Disallow` path wins, and on
 * a tie `Allow` wins (RFC 9309). `*` and a trailing `$` are supported.
 * `Sitemap:` lines are collected whatever the group; `Crawl-delay` is read
 * from the chosen group.
 */

export const ROBOTS_AGENT = "kewyknowledgebot";

export interface RobotsRules {
  rules: { allow: boolean; pattern: string }[];
  sitemaps: string[];
  crawlDelaySeconds: number | null;
}

export const ALLOW_ALL: RobotsRules = { rules: [], sitemaps: [], crawlDelaySeconds: null };
export const DISALLOW_ALL: RobotsRules = { rules: [{ allow: false, pattern: "/" }], sitemaps: [], crawlDelaySeconds: null };

interface Group {
  agents: string[];
  rules: { allow: boolean; pattern: string }[];
  delay: number | null;
}

export function parseRobots(text: string, agent = ROBOTS_AGENT): RobotsRules {
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const raw of String(text ?? "").split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const at = line.indexOf(":");
    if (at < 0) continue;
    const field = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();
    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], delay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (field === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (!current) continue;
    if (field === "allow" || field === "disallow") {
      // An empty Disallow allows everything: no rule.
      if (value) current.rules.push({ allow: field === "allow", pattern: value });
    } else if (field === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.delay = n;
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a === agent || (a !== "*" && agent.startsWith(a))));
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes("*"));
  return {
    rules: chosen.flatMap((g) => g.rules),
    sitemaps,
    crawlDelaySeconds: chosen.map((g) => g.delay).find((d) => d !== null) ?? null,
  };
}

/** Patterns longer than this are ignored (robots.txt is untrusted input). */
const MAX_PATTERN = 512;

/**
 * The rule's priority when `pattern` matches `path` from its start (its
 * length, as RFC 9309 compares), or -1. `*` matches any run, a final `$`
 * anchors the end. Greedy-free: a two-pointer wildcard match, linear in
 * path × pattern at worst.
 */
function matchLength(pattern: string, path: string): number {
  if (pattern.length > MAX_PATTERN) return -1;
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  // Classic wildcard matching of `body` against a prefix of `path`
  // (or the whole path when anchored).
  let p = 0;
  let s = 0;
  let star = -1;
  let mark = 0;
  while (p < body.length || (anchored && s < path.length)) {
    if (p < body.length && body[p] === "*") {
      star = p++;
      mark = s;
    } else if (p < body.length && s < path.length && body[p] === path[s]) {
      p++;
      s++;
    } else if (star >= 0 && mark < path.length) {
      p = star + 1;
      s = ++mark;
    } else {
      return -1;
    }
  }
  return body.length;
}

/** Whether `pathAndQuery` (e.g. "/a/b?x=1") may be fetched. */
export function robotsAllows(r: RobotsRules, pathAndQuery: string): boolean {
  let best: { len: number; allow: boolean } | null = null;
  for (const rule of r.rules) {
    const len = matchLength(rule.pattern, pathAndQuery);
    if (len < 0) continue;
    if (!best || len > best.len || (len === best.len && rule.allow)) best = { len, allow: rule.allow };
  }
  return best ? best.allow : true;
}
