import { isAgentPhoto } from "./media-details";
import type { PrismaService } from "../prisma/prisma.service";

/**
 * SP-17 (ruling 2): the send-time re-check of an image the AI agent returned.
 * `list_photos` hands the agent a URL; a photo hidden between that tool call
 * and the reply must not be sent. Our own media URLs are recognised here and
 * looked up again; any other URL keeps today's behaviour (l validated it).
 */

type Env = Record<string, string | undefined>;

/** Our own media file named by a URL: a media id, or Spaces object-key candidates. */
export type OwnMediaRef = { id: string } | { storedPathCandidates: string[] };

export type AgentImageDecision = "send" | "drop" | "external";

function parse(url: string | undefined): URL | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

function decodeSegments(pathname: string): string[] | null {
  try {
    return pathname.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }
}

/**
 * Recognise our own media URLs (pure; query strings are ignored):
 * - `<PUBLIC_BASE_URL|APP_BASE_URL>/api/media/<id>/public?token=…` (local
 *   storage public-token links, as `MediaService.resolveExternalUrl` builds
 *   them) → `{id}`;
 * - a DO Spaces URL on our bucket (virtual-hosted `<bucket>.<endpoint host>`,
 *   path-style `<endpoint host>/<bucket>/…`, or the CDN host) → the object-key
 *   candidates its path ends in (every suffix of two or more segments; keys
 *   are `<workspaceId>/<file>`).
 * Anything else, or a malformed URL → null.
 */
export function parseOwnMediaUrl(url: string, env: Env = process.env): OwnMediaRef | null {
  const u = parse(url);
  if (!u) return null;

  const bases = [env.PUBLIC_BASE_URL, env.APP_BASE_URL].filter((b): b is string => Boolean(b));
  if (bases.length === 0) bases.push("http://localhost:3001");
  for (const b of bases) {
    const base = parse(b);
    if (!base || base.origin !== u.origin) continue;
    const prefix = base.pathname.replace(/\/+$/, "");
    if (!u.pathname.startsWith(`${prefix}/`)) continue;
    const m = /^\/api\/media\/([^/]+)\/public\/?$/.exec(u.pathname.slice(prefix.length));
    if (!m) continue;
    try {
      return { id: decodeURIComponent(m[1]) };
    } catch {
      return null;
    }
  }

  const bucket = env.DO_SPACES_BUCKET?.toLowerCase();
  const endpoint = parse(env.DO_SPACES_ENDPOINT);
  const cdn = parse(env.DO_SPACES_CDN_ENDPOINT);
  if (!bucket) return null;
  const host = u.host.toLowerCase();
  let segments: string[] | null = null;
  if ((endpoint && host === `${bucket}.${endpoint.host}`) || (cdn && host === cdn.host)) {
    segments = decodeSegments(u.pathname);
  } else if (endpoint && host === endpoint.host) {
    const all = decodeSegments(u.pathname);
    if (all && all[0]?.toLowerCase() === bucket) segments = all.slice(1);
    else return null;
  } else {
    return null;
  }
  if (!segments) return null;
  const storedPathCandidates: string[] = [];
  for (let i = 0; i <= segments.length - 2; i++) storedPathCandidates.push(segments.slice(i).join("/"));
  return { storedPathCandidates };
}

type MediaFinder = Pick<PrismaService, "media">;

/**
 * What to do with the agent reply's image:
 * - `external`: not our URL; sent as today;
 * - `send`: our file, in this workspace, still approved and still a photo
 *   type within the size cap;
 * - `drop`: our URL, but not (hidden since, never approved, a PDF, deleted,
 *   or another workspace's file). The caller sends the text alone.
 * `mediaId` is for logs (never the token).
 */
export async function agentImageDecision(
  prisma: MediaFinder,
  workspaceId: string,
  url: string,
  env: Env = process.env,
): Promise<{ decision: AgentImageDecision; mediaId: string | null }> {
  const ref = parseOwnMediaUrl(url, env);
  if (!ref) return { decision: "external", mediaId: null };
  if ("storedPathCandidates" in ref && ref.storedPathCandidates.length === 0) {
    return { decision: "drop", mediaId: null };
  }
  const row = await prisma.media.findFirst({
    where:
      "id" in ref
        ? { id: ref.id, workspaceId }
        : { workspaceId, storedPath: { in: ref.storedPathCandidates } },
    select: { id: true, mimeType: true, sizeBytes: true, approvedForAgent: true },
  });
  if (row && isAgentPhoto(row)) return { decision: "send", mediaId: row.id };
  return { decision: "drop", mediaId: row?.id ?? ("id" in ref ? ref.id : null) };
}
