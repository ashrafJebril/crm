import { isAgentPhoto } from "./media-details";
import type { PrismaService } from "../prisma/prisma.service";

/**
 * SP-17 (ruling 2): the send-time re-check of an image the AI agent returned.
 * `list_photos` hands the agent a URL; a photo hidden between that tool call
 * and the reply must not be sent. Our own media URLs are recognised here and
 * looked up again (and dropped unless still approved, failing closed); any
 * other URL keeps today's behaviour (l validated it).
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

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment; // a malformed escape is kept raw (and so is looked up, then dropped)
  }
}

/** A host compared as DNS does: lowercase, no trailing dot, no port. */
function normalHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/, "");
}

/** The host of an env URL, normalised; null when unset or malformed. */
function envHost(value: string | undefined): string | null {
  const u = parse(value);
  return u ? normalHost(u.hostname) : null;
}

/** `<region>.digitaloceanspaces.com` → `<bucket>.<region>.cdn.digitaloceanspaces.com`. */
function derivedCdnHost(endpointHost: string | null, bucket: string): string | null {
  const m = endpointHost ? /^([a-z0-9-]+)\.digitaloceanspaces\.com$/.exec(endpointHost) : null;
  return m ? `${bucket}.${m[1]}.cdn.digitaloceanspaces.com` : null;
}

/**
 * Recognise our own media URLs (pure; query strings are ignored). SP-17
 * review M1: anything that looks like ours fails closed (it is looked up, and
 * dropped unless it is an approved photo of this workspace), so a changed
 * form of a URL we handed out never passes as `external`.
 * - a path ending in `/api/media/<id>/public` (optionally `/`), on ANY host
 *   and scheme, case-insensitive, after percent-decoding each segment. Our
 *   server routes such paths case-insensitively (Express) behind any alias
 *   host, so the host is not trusted to tell ours from theirs → `{id}`;
 * - a DO Spaces URL on our bucket, the host normalised (lowercase, no
 *   trailing dot, port and scheme ignored): virtual-hosted
 *   `<bucket>.<endpoint host>`, path-style `<endpoint host>/<bucket>/…`, the
 *   configured CDN host, or the bucket's DO CDN host derived from the
 *   endpoint → the object-key candidates its path ends in (every suffix of
 *   two or more decoded segments; keys are `<workspaceId>/<file>`).
 * Anything else, or a malformed URL → null.
 */
export function parseOwnMediaUrl(url: string, env: Env = process.env): OwnMediaRef | null {
  const u = parse(url);
  if (!u) return null;

  const raw = u.pathname.replace(/\/$/, "").split("/");
  const segments = raw.map(decodeSegment);
  if (segments.length >= 4) {
    const [api, media, id, pub] = segments.slice(-4);
    if (api.toLowerCase() === "api" && media.toLowerCase() === "media" && pub.toLowerCase() === "public") {
      return id ? { id } : null;
    }
  }

  const bucket = env.DO_SPACES_BUCKET?.trim().toLowerCase();
  if (!bucket) return null;
  const endpoint = envHost(env.DO_SPACES_ENDPOINT);
  const own = new Set<string>();
  if (endpoint) own.add(`${bucket}.${endpoint}`);
  const cdn = envHost(env.DO_SPACES_CDN_ENDPOINT);
  if (cdn) own.add(cdn);
  const derived = derivedCdnHost(endpoint, bucket);
  if (derived) own.add(derived);

  const host = normalHost(u.hostname);
  const parts = segments.filter(Boolean);
  let key: string[];
  if (own.has(host)) key = parts;
  else if (endpoint && host === endpoint && parts[0]?.toLowerCase() === bucket) key = parts.slice(1);
  else return null;
  const storedPathCandidates: string[] = [];
  for (let i = 0; i <= key.length - 2; i++) storedPathCandidates.push(key.slice(i).join("/"));
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
  const fallbackId = "id" in ref ? ref.id : null;
  let row: { id: string; mimeType: string; sizeBytes: number; approvedForAgent: boolean } | null;
  try {
    row = await prisma.media.findFirst({
      where:
        "id" in ref
          ? { id: ref.id, workspaceId }
          : { workspaceId, storedPath: { in: ref.storedPathCandidates } },
      select: { id: true, mimeType: true, sizeBytes: true, approvedForAgent: true },
    });
  } catch {
    // Our URL, but we cannot confirm it: fail closed.
    return { decision: "drop", mediaId: fallbackId };
  }
  if (row && isAgentPhoto(row)) return { decision: "send", mediaId: row.id };
  return { decision: "drop", mediaId: row?.id ?? fallbackId };
}
