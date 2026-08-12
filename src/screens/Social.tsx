import { memo, useEffect, useMemo, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { useAuth } from "@/auth/context";
import { PageHeader } from "@/components/PageHeader";
import { Avatar } from "@/components/Avatar";
import { PhotoSlot } from "@/components/PhotoSlot";
import { CommentSkeleton, PostCardSkeleton } from "@/components/Skeleton";
import {
  IconBolt,
  IconCheckCircle,
  IconChev,
  IconHand,
  IconMore,
  IconSend,
  IconStar,
} from "@/icons";
import { SOCIAL_POSTS } from "@/data/social";
import { PLATFORM_LABEL } from "@/lib/types";
import type { SocialComment, SocialPlatform, SocialPost } from "@/lib/types";
import { useFetch, useMutation } from "@/api/useFetch";
import { api } from "@/api/client";
import { ComposeModal } from "@/components/ComposeModal";
import { ScheduledPanel } from "@/components/ScheduledPanel";

/* ── Live Facebook API shapes ────────────────────────────────────────────── */

interface LiveFbPost {
  id: string;
  body: string;
  mediaUrl?: string;
  attachmentType?: string;
  attachmentTitle?: string;
  permalink?: string;
  createdAt: string;
  likes: number;
  comments: number;
  shares: number;
}

interface LiveFbComment {
  id: string;
  author: string;
  authorId?: string;
  body: string;
  likes: number;
  at: string;
  replyCount: number;
  accountId?: string | null;
}

/* ── Inline platform glyphs ──────────────────────────────────────────────── */

interface GlyphProps {
  size?: number;
}

function FbGlyph({ size = 12 }: GlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M14 8h2.5V5H14c-2 0-3.5 1.5-3.5 3.5V11H8v3h2.5v7H14v-7h2.5l.5-3H14V9c0-.6.4-1 1-1z"
        fill="#fff"
      />
    </svg>
  );
}

function IgGlyph({ size = 12 }: GlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#fff"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.5" cy="6.5" r="0.6" fill="#fff" stroke="none" />
    </svg>
  );
}

function TkGlyph({ size = 12 }: GlyphProps) {
  // Abstract music-note mark — not brand-perfect, intentionally so.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#fff"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M10 5v10.5a3 3 0 1 1-3-3" />
      <path d="M10 5c.5 2.6 2.4 4.5 5 5" />
      <path d="M10 5c.2 1.5 1 2.6 2 3.4" opacity={0.55} />
    </svg>
  );
}

const PLATFORM_BG: Record<SocialPlatform, string> = {
  facebook: "#1877F2",
  instagram:
    "linear-gradient(135deg, #f09433 0%, #e6683c 25%, #dc2743 50%, #cc2366 75%, #bc1888 100%)",
  tiktok: "linear-gradient(135deg, #25F4EE 0%, #111 50%, #FE2C55 100%)",
};

interface PlatformMarkProps {
  platform: SocialPlatform;
  size?: number;
}

function PlatformMark({ platform, size = 18 }: PlatformMarkProps) {
  const glyphSize = Math.round(size * 0.7);
  const Glyph =
    platform === "facebook" ? FbGlyph : platform === "instagram" ? IgGlyph : TkGlyph;
  return (
    <span
      title={PLATFORM_LABEL[platform]}
      style={{
        width: size,
        height: size,
        borderRadius: Math.max(4, Math.round(size * 0.28)),
        background: PLATFORM_BG[platform],
        display: "inline-grid",
        placeItems: "center",
        flex: "0 0 auto",
        boxShadow: "0 0 0 1.5px var(--bg)",
      }}
    >
      <Glyph size={glyphSize} />
    </span>
  );
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

const PLATFORMS: SocialPlatform[] = ["facebook", "instagram", "tiktok"];

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

interface CommentSheet {
  comments: SocialComment[];
}

type CommentMap = Record<string, CommentSheet>;
type SortMode = "top" | "new";

/** Compact, locale-agnostic timestamp display for live posts/comments. */
function formatCompactDate(iso: string | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const diffMs = Date.now() - t;
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "now";
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d`;
  const d = new Date(t);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function makeHandle(name: string | undefined): string {
  return "@" + (name ?? "page").toLowerCase().replace(/\s+/g, "");
}

/* ── Screen ──────────────────────────────────────────────────────────────── */

function SocialImpl() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const { user } = useAuth();
  const isAr = t.lang === "ar";

  const [platform, setPlatform] = useState<SocialPlatform>("facebook");
  const [sortMode, setSortMode] = useState<SortMode>("top");
  const [draft, setDraft] = useState<string>("");
  const [composeOpen, setComposeOpen] = useState(false);
  const [scheduledRefresh, setScheduledRefresh] = useState(0);

  // Comment the composer is currently replying to (Zernio only supports
  // replies, not top-level comments, so the composer is reply-only).
  const [replyTo, setReplyTo] = useState<SocialComment | null>(null);

  // Per-post local comment overrides (additions + like toggles).
  const [overrides, setOverrides] = useState<CommentMap>({});

  // Currently-selected post id, per platform.
  const [selectedByPlatform, setSelectedByPlatform] = useState<
    Record<SocialPlatform, string | null>
  >({ facebook: null, instagram: null, tiktok: null });

  /* ── Zernio integrations (FB/IG connect + feeds) ──────────────────────── */
  // FB/IG connect through Zernio now. Connection state comes from the Zernio
  // account list; the feed comes from Zernio's /posts (a page's existing posts
  // backfill via Zernio's ~90-min external sync, so it can be sparse at first).
  const zernioStatusQ = useFetch<{ accounts?: { platform: string; name?: string | null }[] }>(
    "/integrations/zernio/status",
  );
  const zernioAccount = (p: string) =>
    zernioStatusQ.data?.accounts?.find((a) => a.platform === p);

  const fbConnected = !!zernioAccount("facebook");
  const fbPageName = zernioAccount("facebook")?.name ?? undefined;
  const isFbLive = platform === "facebook" && fbConnected;

  const liveFbQ = useFetch<LiveFbPost[]>(
    fbConnected ? "/integrations/zernio/posts?platform=facebook" : null,
  );

  // Set of post IDs that came from the live feed (for source-of-truth checks).
  const liveFbPostIds = useMemo<Set<string>>(() => {
    const s = new Set<string>();
    for (const p of liveFbQ.data ?? []) s.add(p.id);
    return s;
  }, [liveFbQ.data]);

  // Build SocialPost-shaped objects from live API data. We carry mediaUrl on
  // a side-channel map (`liveMediaMap`) since SocialPost doesn't have that
  // field — we look it up at render time.
  const livePosts: SocialPost[] = useMemo(() => {
    if (!liveFbQ.data) return [];
    return liveFbQ.data.map<SocialPost>((p) => ({
      id: p.id,
      platform: "facebook",
      author: fbPageName ?? "Facebook Page",
      authorHandle: makeHandle(fbPageName),
      authorVerified: true,
      body: p.body,
      bodyAr: undefined,
      mediaLabel: p.attachmentTitle ?? "Post",
      postedAt: formatCompactDate(p.createdAt),
      likes: p.likes,
      shares: p.shares,
      comments: [],
    }));
  }, [liveFbQ.data, fbPageName]);

  /* ── Live Instagram integration ───────────────────────────────────────── */
  interface LiveIgPost {
    id: string;
    body: string;
    mediaUrl?: string;
    attachmentType?: string;
    permalink?: string;
    createdAt?: string;
    likes: number;
    comments: number;
    shares: number;
  }
  const igConnected = !!zernioAccount("instagram");
  const igUsername = zernioAccount("instagram")?.name ?? undefined;
  const isIgLive = platform === "instagram" && igConnected;

  const liveIgQ = useFetch<LiveIgPost[]>(
    igConnected ? "/integrations/zernio/posts?platform=instagram" : null,
  );

  const liveIgPostIds = useMemo<Set<string>>(() => {
    const s = new Set<string>();
    for (const p of liveIgQ.data ?? []) s.add(p.id);
    return s;
  }, [liveIgQ.data]);

  const liveIgPosts: SocialPost[] = useMemo(() => {
    if (!liveIgQ.data) return [];
    return liveIgQ.data.map<SocialPost>((p) => ({
      id: p.id,
      platform: "instagram",
      author: igUsername ?? "Instagram",
      authorHandle: makeHandle(igUsername),
      authorVerified: true,
      body: p.body,
      bodyAr: undefined,
      mediaLabel: p.attachmentType ?? "Post",
      postedAt: formatCompactDate(p.createdAt ?? ""),
      likes: p.likes,
      shares: p.shares,
      comments: [],
    }));
  }, [liveIgQ.data, igUsername]);

  const liveMediaMap = useMemo<Record<string, string>>(() => {
    const m: Record<string, string> = {};
    for (const p of liveFbQ.data ?? []) {
      if (p.mediaUrl) m[p.id] = p.mediaUrl;
    }
    for (const p of liveIgQ.data ?? []) {
      if (p.mediaUrl) m[p.id] = p.mediaUrl;
    }
    return m;
  }, [liveFbQ.data, liveIgQ.data]);

  /* ── Per-platform feed (memoized) ─────────────────────────────────────── */
  // No mock fallback — when an integration isn't connected (or has no posts),
  // show an empty state rather than seeded demo content. The seeded
  // `SOCIAL_POSTS` array is kept only for the IG/TikTok "coming soon" tabs
  // until we build real feeds for them.
  const feed: SocialPost[] = useMemo(() => {
    if (platform === "facebook") return fbConnected ? livePosts : [];
    if (platform === "instagram") return igConnected ? liveIgPosts : [];
    return [];
  }, [platform, fbConnected, livePosts, igConnected, liveIgPosts]);

  const platformCounts = useMemo<Record<SocialPlatform, number>>(() => {
    return {
      facebook: fbConnected ? livePosts.length : 0,
      instagram: igConnected ? liveIgPosts.length : 0,
      tiktok: 0,
    };
  }, [fbConnected, livePosts.length, igConnected, liveIgPosts.length]);
  void SOCIAL_POSTS;

  // Fall back to the platform's first post if nothing chosen yet.
  const selectedId = selectedByPlatform[platform] ?? feed[0]?.id ?? null;
  const baseSelected = useMemo(
    () => feed.find((p) => p.id === selectedId) ?? feed[0] ?? null,
    [feed, selectedId],
  );

  // If the currently-selected post came from a live feed (FB or IG), load
  // its comments from the backend on demand. Both endpoints return the same
  // shape (LiveFbComment).
  const selectedIsLive =
    baseSelected !== null &&
    ((baseSelected.platform === "facebook" && liveFbPostIds.has(baseSelected.id)) ||
      (baseSelected.platform === "instagram" && liveIgPostIds.has(baseSelected.id)));
  const liveCommentsQ = useFetch<LiveFbComment[]>(
    selectedIsLive && baseSelected
      ? `/integrations/zernio/comments?platform=${baseSelected.platform}`
      : null,
  );

  // Track which post id we most-recently received a comments payload for.
  // Used to gate the skeleton: any post switch should show loading until
  // the new query lands, even if the override cache from a prior visit
  // would otherwise paper over the transition.
  const [loadedCommentsFor, setLoadedCommentsFor] = useState<string | null>(null);

  // Mirror server-fetched comments into our local override map so that
  // the rest of the screen (sorting, like-toggle, composer) keeps working
  // unchanged.
  useEffect(() => {
    if (!selectedIsLive || !baseSelected) return;
    const list = liveCommentsQ.data;
    if (!list) return;
    const mapped: SocialComment[] = list.map((c) => ({
      id: c.id,
      author: c.author,
      authorHandle: makeHandle(c.author),
      body: c.body,
      likes: c.likes,
      at: formatCompactDate(c.at),
      accountId: c.accountId,
    }));
    setOverrides((prev) => {
      const existing = prev[baseSelected.id]?.comments;
      // Avoid an infinite loop: only update if shape differs.
      if (
        existing &&
        existing.length === mapped.length &&
        existing.every((c, i) => c.id === mapped[i]?.id)
      ) {
        return prev;
      }
      return { ...prev, [baseSelected.id]: { comments: mapped } };
    });
    setLoadedCommentsFor(baseSelected.id);
  }, [selectedIsLive, liveCommentsQ.data, baseSelected]);

  // Whether the comments visible in the side panel are fresh for the
  // selected post. Drives the skeleton during post-to-post navigation.
  const commentsAreFresh =
    !selectedIsLive ||
    (loadedCommentsFor === baseSelected?.id && !liveCommentsQ.loading);

  // Apply overrides on top of the base selected post.
  const selected: SocialPost | null = useMemo(() => {
    if (!baseSelected) return null;
    const override = overrides[baseSelected.id];
    if (!override) return baseSelected;
    return { ...baseSelected, comments: override.comments };
  }, [baseSelected, overrides]);

  /* ── Zernio comment mutations (reply + delete) ────────────────────────── */
  // Comments on externally-published posts flow through Zernio: replying to
  // a comment is the only write Zernio supports (no top-level comment create,
  // no post edit/delete on posts published outside our composer).
  const zernioReplyMut = useMutation<
    { commentId: string; message: string; accountId?: string },
    { id: string | null }
  >((input) =>
    api.post(`/integrations/zernio/comments/${input.commentId}/reply`, {
      message: input.message,
      accountId: input.accountId,
    }),
  );

  const zernioDeleteMut = useMutation<
    { commentId: string; accountId?: string },
    { ok: boolean }
  >((input) =>
    api.delete(
      `/integrations/zernio/comments/${input.commentId}` +
        (input.accountId ? `?accountId=${encodeURIComponent(input.accountId)}` : ""),
    ),
  );

  function deleteComment(c: SocialComment) {
    if (!selected) return;
    const isLocalOnly = c.id.includes("-local-");
    const postId = selected.id;
    // Optimistic remove
    const before = getCurrentComments(selected);
    const after = before.filter((x) => x.id !== c.id);
    writeComments(postId, after);
    if (isLocalOnly) return; // never made it to the platform, nothing to call
    if (!liveFbPostIds.has(postId) && !liveIgPostIds.has(postId)) return;
    zernioDeleteMut
      .mutate({ commentId: c.id, accountId: c.accountId ?? undefined })
      .catch(() => {
        // Restore on failure so the operator sees the comment didn't actually delete.
        writeComments(postId, before);
      });
  }

  /* ── Insights for the active platform ─────────────────────────────────── */
  const insights = useMemo(() => {
    const posts = feed;
    let likes = 0;
    let comments = 0;
    let topPost: SocialPost | null = null;
    for (const p of posts) {
      likes += p.likes;
      comments += p.comments.length;
      if (!topPost || p.likes > topPost.likes) topPost = p;
    }
    return {
      posts: posts.length,
      likes,
      comments,
      topPost,
    };
  }, [feed]);

  /* ── Sorted comment view ──────────────────────────────────────────────── */
  const sortedComments: SocialComment[] = useMemo(() => {
    if (!selected) return [];
    const list = [...selected.comments];
    if (sortMode === "top") {
      list.sort((a, b) => b.likes - a.likes);
    }
    // "new" preserves insertion order — newest comments are pushed at the end,
    // so reverse to surface them first.
    else {
      list.reverse();
    }
    return list;
  }, [selected, sortMode]);

  /* ── Mutations on local state ─────────────────────────────────────────── */
  function getCurrentComments(post: SocialPost): SocialComment[] {
    return overrides[post.id]?.comments ?? post.comments;
  }

  function writeComments(postId: string, next: SocialComment[]) {
    setOverrides((prev) => ({ ...prev, [postId]: { comments: next } }));
  }

  function toggleLike(commentId: string) {
    if (!selected) return;
    const current = getCurrentComments(selected);
    const next = current.map((c) =>
      c.id === commentId
        ? {
            ...c,
            liked: !c.liked,
            likes: c.likes + (c.liked ? -1 : 1),
          }
        : c,
    );
    writeComments(selected.id, next);
  }

  function submitComment() {
    if (!selected || !user || !replyTo) return;
    const body = draft.trim();
    if (!body) return;
    const localId = `${selected.id}-local-${Date.now()}`;
    const newComment: SocialComment = {
      id: localId,
      author: user.name,
      authorHandle: `@${user.email.split("@")[0] ?? "you"}`,
      body,
      likes: 0,
      at: tx("now", "الآن"),
    };
    const postId = selected.id;
    writeComments(postId, [...getCurrentComments(selected), newComment]);
    setDraft("");
    zernioReplyMut
      .mutate({ commentId: replyTo.id, message: body, accountId: replyTo.accountId ?? undefined })
      .then((res) => {
        if (res.id) {
          setOverrides((prev) => {
            const list = prev[postId]?.comments ?? [];
            return {
              ...prev,
              [postId]: { comments: list.map((c) => (c.id === localId ? { ...c, id: res.id! } : c)) },
            };
          });
        }
        setReplyTo(null);
      })
      .catch(() => {
        // Roll back the optimistic row so a failed reply isn't shown as posted.
        setOverrides((prev) => {
          const list = prev[postId]?.comments ?? [];
          return { ...prev, [postId]: { comments: list.filter((c) => c.id !== localId) } };
        });
      });
  }

  function selectPlatform(p: SocialPlatform) {
    setPlatform(p);
    setReplyTo(null);
  }

  function selectPost(id: string) {
    setSelectedByPlatform((prev) => ({ ...prev, [platform]: id }));
    setReplyTo(null);
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 0,
      }}
    >
      <PageHeader
        title={tx("Social", "التواصل الاجتماعي")}
        subtitle={tx(
          "Posts and comments across Samemha's channels",
          "المنشورات والتعليقات على قنوات صممها",
        )}
        actions={
          <>
            <button className="btn primary" onClick={() => setComposeOpen(true)}>
              <IconBolt w={13} />
              {tx("Compose", "إنشاء منشور")}
            </button>
          </>
        }
      />

      <div className="tabs" style={{ padding: "0 24px" }}>
        {PLATFORMS.map((p) => (
          <button
            key={p}
            className={`tab ${platform === p ? "active" : ""}`.trim()}
            onClick={() => selectPlatform(p)}
            type="button"
          >
            <PlatformMark platform={p} size={16} />
            <span>{PLATFORM_LABEL[p]}</span>
            <span className="count">{platformCounts[p]}</span>
          </button>
        ))}
      </div>

      <ScheduledPanel refreshKey={scheduledRefresh} />

      <div
        className="social-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(360px, 1.05fr) minmax(420px, 1.4fr) 280px",
          flex: 1,
          minHeight: 0,
        }}
      >
        {/* ── Column 1: Feed ─────────────────────────────────────────── */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            borderInlineEnd: "1px solid var(--line-soft)",
            minHeight: 0,
          }}
        >
          <div
            style={{
              padding: "10px 16px",
              borderBottom: "1px solid var(--line-soft)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <span
              className="mono muted"
              style={{ fontSize: 11, letterSpacing: 0.06, textTransform: "uppercase" }}
            >
              {tx("Feed", "الموجز")} · {PLATFORM_LABEL[platform]}
            </span>
            {platform === "facebook" && fbConnected && fbPageName && (
              <span
                className="mono"
                style={{
                  fontSize: 11,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "2px 8px",
                  borderRadius: 999,
                  background: "var(--ok-soft, oklch(0.92 0.08 150 / 0.18))",
                  color: "var(--ok)",
                  border: "1px solid var(--line-soft)",
                }}
                title={tx("Live data", "بيانات حيّة")}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: "var(--ok)",
                    display: "inline-block",
                  }}
                />
                {tx(`Connected · ${fbPageName}`, `متصل · ${fbPageName}`)}
              </span>
            )}
            <span className="mono muted" style={{ fontSize: 11 }}>
              {feed.length} {tx("posts", "منشور")}
            </span>
          </div>
          {platform === "facebook" && (
            <div
              style={{
                padding: "8px 16px",
                borderBottom: "1px solid var(--line-soft)",
                fontSize: 11.5,
                color: fbConnected ? "var(--ink-2)" : "var(--ink-3)",
                background: fbConnected ? "var(--bg-1)" : "var(--bg-2)",
              }}
            >
              {fbConnected
                ? tx(
                    `Showing real posts from ${fbPageName ?? "your page"} on Facebook`,
                    `منشورات حقيقية من ${fbPageName ?? "صفحتك"} على فيسبوك`,
                  )
                : tx(
                    "Facebook isn't connected — connect it in Settings → Integrations",
                    "فيسبوك غير مرتبط — اربطه من الإعدادات ← التكاملات",
                  )}
              {liveFbQ.loading && (
                <span className="mono muted" style={{ marginInlineStart: 8 }}>
                  · {tx("loading…", "تحميل…")}
                </span>
              )}
              {liveFbQ.error && (
                <span style={{ color: "var(--bad)", marginInlineStart: 8 }}>
                  · {liveFbQ.error}
                </span>
              )}
            </div>
          )}
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              padding: 14,
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            {((isFbLive && liveFbQ.loading) || (isIgLive && liveIgQ.loading)) &&
            feed.length === 0 ? (
              <div
                aria-label={tx("Loading posts", "جارٍ تحميل المنشورات")}
                style={{ display: "flex", flexDirection: "column", gap: 12 }}
              >
                {Array.from({ length: 3 }).map((_, i) => (
                  <PostCardSkeleton key={i} />
                ))}
              </div>
            ) : null}
            {!((isFbLive && liveFbQ.loading) || (isIgLive && liveIgQ.loading)) &&
              feed.length === 0 && (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 8,
                    padding: "48px 16px",
                    textAlign: "center",
                    color: "var(--ink-3)",
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 500, color: "var(--ink-2)" }}>
                    {platform === "facebook" && !fbConnected
                      ? tx("Facebook isn't connected yet", "فيسبوك غير مرتبط")
                      : platform === "facebook"
                        ? tx("No posts on this page yet", "لا توجد منشورات على هذه الصفحة")
                        : platform === "instagram" && !igConnected
                          ? tx("Instagram isn't connected yet", "إنستغرام غير مرتبط")
                          : platform === "instagram"
                            ? tx("No posts on this account yet", "لا توجد منشورات على هذا الحساب")
                            : tx("TikTok coming soon", "تيك توك قريبًا")}
                  </div>
                  <div className="mono" style={{ fontSize: 11 }}>
                    {platform === "facebook" && !fbConnected
                      ? tx(
                          "Settings → Integrations → Connect Facebook",
                          "الإعدادات ← التكاملات ← اربط فيسبوك",
                        )
                      : platform === "instagram" && !igConnected
                        ? tx(
                            "Connect Facebook in Settings — Instagram links automatically.",
                            "اربط فيسبوك من الإعدادات — يُربط إنستغرام تلقائيًا.",
                          )
                        : platform === "tiktok"
                          ? tx("We'll add live feeds for this channel.", "سنضيف الموجز الحي قريبًا.")
                          : tx("Publish a post to see it here.", "انشر منشورًا ليظهر هنا.")}
                  </div>
                </div>
              )}
            {!(
              ((isFbLive && liveFbQ.loading) || (isIgLive && liveIgQ.loading)) &&
              feed.length === 0
            ) &&
              feed.map((post) => {
              const isActive = selected?.id === post.id;
              const body = isAr && post.bodyAr ? post.bodyAr : post.body;
              const liveComments = getCurrentComments(post);
              return (
                <div
                  key={post.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => selectPost(post.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      selectPost(post.id);
                    }
                  }}
                  className="post-card"
                  data-active={isActive ? "true" : "false"}
                  style={{
                    textAlign: "start",
                    padding: 14,
                    border: `1px solid ${isActive ? "var(--accent-ring)" : "var(--line-soft)"}`,
                    background: isActive ? "var(--accent-soft)" : "var(--bg-1)",
                    borderRadius: 12,
                    cursor: "pointer",
                    display: "flex",
                    flexDirection: "column",
                    gap: 10,
                    color: "inherit",
                    font: "inherit",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ position: "relative", flex: "0 0 auto" }}>
                      <Avatar name={post.author} color="200" size="lg" />
                      <span
                        style={{
                          position: "absolute",
                          insetInlineEnd: -2,
                          bottom: -2,
                          display: "inline-flex",
                        }}
                      >
                        <PlatformMark platform={post.platform} size={14} />
                      </span>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          minWidth: 0,
                        }}
                      >
                        <span
                          style={{
                            fontWeight: 600,
                            fontSize: 13.5,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {post.author}
                        </span>
                        {post.authorVerified && (
                          <span
                            style={{
                              color: "var(--accent)",
                              display: "inline-flex",
                            }}
                            title={tx("Verified", "موثّق")}
                          >
                            <IconCheckCircle w={13} />
                          </span>
                        )}
                      </div>
                      <div
                        className="mono muted"
                        style={{
                          fontSize: 11,
                          display: "flex",
                          gap: 6,
                          alignItems: "center",
                        }}
                      >
                        <span>{post.authorHandle}</span>
                        <span>·</span>
                        <span>{post.postedAt}</span>
                      </div>
                    </div>
                    {/* Zernio can't edit/delete externally-published posts, so
                        this is decorative — no action menu. */}
                    <span
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        color: "var(--ink-3)",
                        display: "inline-flex",
                        padding: 4,
                      }}
                    >
                      <IconMore w={14} />
                    </span>
                  </div>

                  <div
                    style={{
                      fontSize: 13.5,
                      lineHeight: 1.5,
                      color: "var(--ink-1)",
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {body}
                  </div>

                  {liveMediaMap[post.id] ? (
                    <img
                      src={liveMediaMap[post.id]}
                      alt={post.mediaLabel ?? ""}
                      loading="lazy"
                      style={{
                        width: "100%",
                        height: post.platform === "tiktok" ? 320 : 200,
                        objectFit: "cover",
                        borderRadius: "var(--r-md)",
                        background: "var(--bg-2)",
                      }}
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = "none";
                      }}
                    />
                  ) : (
                    <PhotoSlot
                      label={post.mediaLabel ?? tx("media", "وسائط")}
                      h={post.platform === "tiktok" ? 320 : 200}
                    />
                  )}

                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 14,
                      fontSize: 12,
                      color: "var(--ink-2)",
                      fontFamily: "var(--font-mono)",
                      paddingTop: 4,
                      borderTop: "1px solid var(--line-soft)",
                      marginTop: 2,
                    }}
                  >
                    <span title={tx("Likes", "إعجابات")}>
                      ❤︎ {formatCount(post.likes)}
                    </span>
                    <span title={tx("Shares", "مشاركات")}>
                      ↗ {formatCount(post.shares)}
                    </span>
                    <span title={tx("Comments", "تعليقات")}>
                      💬 {liveComments.length}
                    </span>
                    {post.platform === "tiktok" && post.views !== undefined && (
                      <span
                        style={{ marginInlineStart: "auto" }}
                        title={tx("Views", "مشاهدات")}
                      >
                        ▶ {formatCount(post.views)}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Column 2: Detail + comments ────────────────────────────── */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
            background: "var(--bg)",
          }}
        >
          {selected ? (
            <>
              <div
                style={{
                  padding: "14px 18px",
                  borderBottom: "1px solid var(--line-soft)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <PlatformMark platform={selected.platform} size={16} />
                  <span style={{ fontWeight: 600, fontSize: 14 }}>
                    {selected.author}
                  </span>
                  {selected.authorVerified && (
                    <span style={{ color: "var(--accent)", display: "inline-flex" }}>
                      <IconCheckCircle w={13} />
                    </span>
                  )}
                  <span className="mono muted" style={{ fontSize: 11 }}>
                    {selected.authorHandle} · {selected.postedAt}
                  </span>
                </div>
                <div
                  style={{
                    fontSize: 13.5,
                    lineHeight: 1.55,
                    color: "var(--ink-1)",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {isAr && selected.bodyAr ? selected.bodyAr : selected.body}
                </div>
              </div>

              <div
                style={{
                  padding: "10px 18px",
                  borderBottom: "1px solid var(--line-soft)",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 500 }}>
                  {sortedComments.length}{" "}
                  <span className="muted" style={{ fontWeight: 400 }}>
                    {tx("comments", "تعليقات")}
                  </span>
                </span>
                <span style={{ marginInlineStart: "auto", display: "flex", gap: 4 }}>
                  <button
                    type="button"
                    className={`btn sm ${sortMode === "top" ? "" : "ghost"}`.trim()}
                    onClick={() => setSortMode("top")}
                  >
                    {tx("Most liked", "الأكثر إعجاباً")}
                  </button>
                  <button
                    type="button"
                    className={`btn sm ${sortMode === "new" ? "" : "ghost"}`.trim()}
                    onClick={() => setSortMode("new")}
                  >
                    {tx("Newest", "الأحدث")}
                  </button>
                </span>
              </div>

              <div
                style={{
                  flex: 1,
                  overflowY: "auto",
                  padding: "12px 18px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                }}
              >
                {selectedIsLive && !commentsAreFresh ? (
                  <div
                    aria-label={tx("Loading comments", "جارٍ تحميل التعليقات")}
                    style={{ display: "flex", flexDirection: "column", gap: 12 }}
                  >
                    {Array.from({ length: 3 }).map((_, i) => (
                      <CommentSkeleton key={i} />
                    ))}
                  </div>
                ) : null}
                {!(selectedIsLive && !commentsAreFresh) && sortedComments.map((c) => {
                  const cBody = isAr && c.bodyAr ? c.bodyAr : c.body;
                  return (
                    <div
                      key={c.id}
                      style={{ display: "flex", gap: 10, alignItems: "flex-start" }}
                    >
                      <Avatar name={c.author} color="200" size="sm" />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            flexWrap: "wrap",
                          }}
                        >
                          <span style={{ fontWeight: 600, fontSize: 13 }}>
                            {c.author}
                          </span>
                          <span
                            className="mono muted"
                            style={{ fontSize: 11 }}
                          >
                            {c.authorHandle}
                          </span>
                          <span
                            className="mono muted"
                            style={{ fontSize: 11 }}
                          >
                            · {c.at}
                          </span>
                        </div>
                        <div
                          style={{
                            fontSize: 13,
                            lineHeight: 1.5,
                            marginTop: 2,
                            color: "var(--ink-1)",
                            whiteSpace: "pre-wrap",
                          }}
                        >
                          {cBody}
                        </div>
                        <div
                          style={{
                            marginTop: 4,
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                          }}
                        >
                          <button
                            type="button"
                            onClick={() => toggleLike(c.id)}
                            className="like-btn"
                            data-liked={c.liked ? "true" : "false"}
                            style={{
                              background: "transparent",
                              border: 0,
                              padding: 0,
                              cursor: "pointer",
                              color: c.liked
                                ? "var(--bad)"
                                : "var(--ink-3)",
                              fontFamily: "var(--font-mono)",
                              fontSize: 11,
                              display: "inline-flex",
                              gap: 4,
                              alignItems: "center",
                            }}
                          >
                            <span>{c.liked ? "❤" : "❤︎"}</span>
                            <span>{c.likes}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              if (
                                window.confirm(
                                  tx(
                                    "Delete this comment?",
                                    "حذف هذا التعليق؟",
                                  ),
                                )
                              ) {
                                deleteComment(c);
                              }
                            }}
                            className="like-btn"
                            disabled={zernioDeleteMut.loading}
                            style={{
                              background: "transparent",
                              border: 0,
                              padding: 0,
                              cursor: "pointer",
                              color: "var(--bad)",
                              fontFamily: "var(--font-mono)",
                              fontSize: 11,
                            }}
                          >
                            {tx("Delete", "حذف")}
                          </button>
                          <button
                            type="button"
                            onClick={() => setReplyTo(c)}
                            className="like-btn"
                            style={{
                              background: "transparent",
                              border: 0,
                              padding: 0,
                              cursor: "pointer",
                              color: replyTo?.id === c.id ? "var(--accent)" : "var(--ink-3)",
                              fontFamily: "var(--font-mono)",
                              fontSize: 11,
                              fontWeight: replyTo?.id === c.id ? 600 : 400,
                            }}
                          >
                            {tx("Reply", "رد")}
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
                {sortedComments.length === 0 && (!selectedIsLive || commentsAreFresh) && (
                  <div
                    className="mono muted"
                    style={{ fontSize: 12, padding: 12 }}
                  >
                    {tx("No comments yet.", "لا توجد تعليقات بعد.")}
                  </div>
                )}
              </div>

              <div
                style={{
                  padding: 14,
                  borderTop: "1px solid var(--line-soft)",
                  background: "var(--bg-1)",
                }}
              >
                <div
                  style={{
                    border: "1px solid var(--line)",
                    borderRadius: 12,
                    background: "var(--bg)",
                    padding: 10,
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                  }}
                >
                  {replyTo && (
                    <div
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        alignSelf: "flex-start",
                        padding: "3px 8px",
                        borderRadius: 999,
                        background: "var(--accent-soft)",
                        border: "1px solid var(--accent-ring)",
                      }}
                    >
                      <span className="mono" style={{ fontSize: 11, color: "var(--ink-2)" }}>
                        {tx("Replying to", "الرد على")}{" "}
                        <strong style={{ color: "var(--ink-1)" }}>{replyTo.author}</strong>
                      </span>
                      <button
                        type="button"
                        onClick={() => setReplyTo(null)}
                        aria-label={tx("Cancel reply", "إلغاء الرد")}
                        style={{
                          background: "transparent",
                          border: 0,
                          padding: 0,
                          cursor: "pointer",
                          color: "var(--ink-3)",
                          fontSize: 13,
                          lineHeight: 1,
                        }}
                      >
                        ×
                      </button>
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                    <Avatar
                      name={user?.name ?? "You"}
                      color={user?.color ?? "150"}
                      size="sm"
                    />
                    <textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          submitComment();
                        }
                      }}
                      disabled={!replyTo}
                      placeholder={
                        replyTo
                          ? tx(`Reply as ${user?.name ?? "you"}…`, `رد بصفتك ${user?.name ?? "أنت"}…`)
                          : tx("Select a comment to reply", "اختر تعليقًا للرد عليه")
                      }
                      style={{
                        flex: 1,
                        minHeight: 44,
                        resize: "none",
                        border: 0,
                        outline: 0,
                        background: "transparent",
                        color: "inherit",
                        fontSize: 13.5,
                        fontFamily: "inherit",
                        lineHeight: 1.5,
                      }}
                    />
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    <span
                      className="muted mono"
                      style={{ fontSize: 11 }}
                    >
                      {tx("Posting as", "نشر بصفة")}{" "}
                      <strong style={{ color: "var(--ink-1)" }}>
                        {user?.name ?? tx("you", "أنت")}
                      </strong>
                    </span>
                    <span style={{ marginInlineStart: "auto", display: "flex", gap: 6 }}>
                      <button
                        type="button"
                        className="btn ghost sm"
                        onClick={() => setDraft("")}
                        disabled={draft.length === 0}
                      >
                        {tx("Clear", "مسح")}
                      </button>
                      <button
                        type="button"
                        className="btn primary"
                        onClick={submitComment}
                        disabled={!replyTo || draft.trim().length === 0}
                      >
                        <IconSend w={13} />
                        {tx("Post comment", "نشر التعليق")}
                      </button>
                    </span>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div
              style={{
                display: "grid",
                placeItems: "center",
                padding: 24,
                color: "var(--ink-3)",
                fontSize: 13,
              }}
            >
              <span>{tx("Select a post", "اختر منشورًا")}</span>
            </div>
          )}
        </div>

        {/* ── Column 3: Insights ─────────────────────────────────────── */}
        <aside
          className="insights-panel"
          style={{
            borderInlineStart: "1px solid var(--line-soft)",
            background: "var(--bg-1)",
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            padding: 18,
            gap: 18,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <PlatformMark platform={platform} size={18} />
            <h3
              style={{
                margin: 0,
                fontSize: 14,
                fontWeight: 600,
              }}
            >
              {PLATFORM_LABEL[platform]} {tx("insights", "إحصاءات")}
            </h3>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 8,
            }}
          >
            <div
              style={{
                border: "1px solid var(--line-soft)",
                borderRadius: 10,
                padding: 12,
                background: "var(--bg)",
              }}
            >
              <div
                className="mono muted"
                style={{
                  fontSize: 10,
                  textTransform: "uppercase",
                  letterSpacing: 0.06,
                }}
              >
                {tx("Posts", "منشورات")}
              </div>
              <div style={{ fontSize: 22, fontWeight: 600, marginTop: 4 }}>
                {insights.posts}
              </div>
            </div>
            <div
              style={{
                border: "1px solid var(--line-soft)",
                borderRadius: 10,
                padding: 12,
                background: "var(--bg)",
              }}
            >
              <div
                className="mono muted"
                style={{
                  fontSize: 10,
                  textTransform: "uppercase",
                  letterSpacing: 0.06,
                }}
              >
                {tx("Likes", "إعجابات")}
              </div>
              <div style={{ fontSize: 22, fontWeight: 600, marginTop: 4 }}>
                {formatCount(insights.likes)}
              </div>
            </div>
            <div
              style={{
                border: "1px solid var(--line-soft)",
                borderRadius: 10,
                padding: 12,
                background: "var(--bg)",
                gridColumn: "1 / -1",
              }}
            >
              <div
                className="mono muted"
                style={{
                  fontSize: 10,
                  textTransform: "uppercase",
                  letterSpacing: 0.06,
                }}
              >
                {tx("Comments", "تعليقات")}
              </div>
              <div style={{ fontSize: 22, fontWeight: 600, marginTop: 4 }}>
                {formatCount(insights.comments)}
              </div>
            </div>
          </div>

          {insights.topPost && (
            <div
              style={{
                border: "1px solid var(--accent-ring)",
                background: "var(--accent-soft)",
                borderRadius: 10,
                padding: 12,
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              <div
                className="mono"
                style={{
                  fontSize: 10,
                  textTransform: "uppercase",
                  letterSpacing: 0.06,
                  color: "var(--accent)",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <IconStar w={11} />
                {tx("Top post", "أفضل منشور")}
              </div>
              <div
                style={{
                  fontSize: 13,
                  color: "var(--ink-1)",
                  lineHeight: 1.4,
                  display: "-webkit-box",
                  WebkitLineClamp: 3,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                }}
              >
                {isAr && insights.topPost.bodyAr
                  ? insights.topPost.bodyAr
                  : insights.topPost.body}
              </div>
              <div
                className="mono muted"
                style={{
                  fontSize: 11,
                  display: "flex",
                  gap: 10,
                }}
              >
                <span>❤︎ {formatCount(insights.topPost.likes)}</span>
                <span>↗ {formatCount(insights.topPost.shares)}</span>
                <span>💬 {insights.topPost.comments.length}</span>
              </div>
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => selectPost(insights.topPost!.id)}
                style={{ marginTop: 4, alignSelf: "flex-start" }}
              >
                {tx("Open", "فتح")}
                <IconChev w={11} />
              </button>
            </div>
          )}

          <div>
            <div
              className="mono muted"
              style={{
                fontSize: 10,
                textTransform: "uppercase",
                letterSpacing: 0.06,
                marginBottom: 8,
              }}
            >
              {tx("Quick actions", "إجراءات سريعة")}
            </div>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              <button className="btn ghost sm" type="button">
                <IconHand w={12} />
                {tx("Auto-reply with AI", "رد تلقائي بالذكاء")}
              </button>
              <button className="btn ghost sm" type="button">
                <IconBolt w={12} />
                {tx("Boost post", "تعزيز المنشور")}
              </button>
              <button className="btn ghost sm" type="button">
                <IconStar w={12} />
                {tx("Save for later", "حفظ لاحقاً")}
              </button>
            </div>
          </div>
        </aside>
      </div>

      <style>{`
        .post-card { transition: transform .12s ease, border-color .12s ease, background .12s ease; }
        .post-card:hover { transform: translateY(-1px); border-color: var(--line); }
        .post-card[data-active="true"] { box-shadow: 0 0 0 1px var(--accent-ring) inset; }
        .like-btn:hover { color: var(--ink) !important; }
        @media (max-width: 1100px) {
          .insights-panel { display: none; }
        }
      `}</style>

      <ComposeModal
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        onPosted={() => {
          if (isFbLive) liveFbQ.refetch();
          setScheduledRefresh((n) => n + 1);
        }}
      />
    </div>
  );
}

const Social = memo(SocialImpl);
export default Social;
