import { Skeleton } from "@/components/Skeleton";

/**
 * Per-card placeholders for the dashboard's first paint.
 *
 * Each one mirrors the real card's layout — same block sizes, same gaps — so
 * the content that replaces it doesn't shift the page. Before these existed
 * every tile rendered a hard "0" while its request was still in flight, which
 * read as real data: an empty inbox and a loading one looked identical.
 */

/** Rows of the "Live activity" feed: avatar + name line + preview line + time. */
export function ActivitySkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px" }}
        >
          <Skeleton w={28} h={28} radius={14} />
          <div style={{ flex: 1, minWidth: 0, display: "grid", gap: 5 }}>
            <Skeleton h={11} w="45%" />
            <Skeleton h={10} w="75%" />
          </div>
          <Skeleton h={10} w={22} />
        </div>
      ))}
    </div>
  );
}

/** "Top intents": a label line above a thin progress bar, repeated. */
export function IntentsSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
            <Skeleton h={11} w="40%" />
            <Skeleton h={11} w={48} />
          </div>
          <Skeleton h={5} radius={3} />
        </div>
      ))}
    </div>
  );
}

/** A headline number with its caption — the shape both the pipeline and
 *  channel cards lead with. */
function HeadlineSkeleton({ w = 90 }: { w?: number }) {
  return (
    <>
      <Skeleton h={24} w={w} />
      <Skeleton h={11} w={70} style={{ marginTop: 6 }} />
    </>
  );
}

/** "Pipeline performance": win rate, the won/lost bar, then two stat rows. */
export function PipelineSkeleton() {
  return (
    <div aria-hidden>
      <HeadlineSkeleton w={72} />
      <Skeleton h={10} radius={999} style={{ marginTop: 14 }} />
      <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
        {[0, 1].map((i) => (
          <div key={i} style={{ display: "flex", justifyContent: "space-between" }}>
            <Skeleton h={11} w={72} />
            <Skeleton h={11} w={40} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** "Active campaigns": name + badge, a mono stats line, then a progress bar. */
export function CampaignsSkeleton({ rows = 2 }: { rows?: number }) {
  return (
    <div aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} style={{ padding: "10px 12px", marginBottom: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Skeleton h={12} w="55%" />
            <Skeleton h={14} w={54} radius={999} style={{ marginInlineStart: "auto" }} />
          </div>
          <Skeleton h={10} w="70%" style={{ marginTop: 6 }} />
          <Skeleton h={4} radius={2} style={{ marginTop: 8 }} />
        </div>
      ))}
    </div>
  );
}

/** "Messages by channel": total, the stacked share bar, then one row per channel. */
export function ChannelsSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div aria-hidden>
      <HeadlineSkeleton w={60} />
      <Skeleton h={10} radius={999} style={{ marginTop: 14 }} />
      <div style={{ marginTop: 14, display: "grid", gap: 8 }}>
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Skeleton w={8} h={8} radius={999} />
            <Skeleton h={11} w="42%" />
            <Skeleton h={11} w={24} style={{ marginInlineStart: "auto" }} />
            <Skeleton h={11} w={34} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** The 7-day area chart plus its day labels. */
export function ChartSkeleton({ h = 180 }: { h?: number }) {
  return (
    <div aria-hidden>
      <Skeleton h={h} radius={8} />
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }}>
        {Array.from({ length: 7 }, (_, i) => (
          <Skeleton key={i} h={11} w={22} />
        ))}
      </div>
    </div>
  );
}
