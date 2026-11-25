import { seamLabel } from "./threadModel";
import type { Lang } from "@/lib/types";

/** Divider between two conversations of the same customer in the stitched thread. */
export function SegmentSeam({
  channel,
  startedAt,
  lang,
}: {
  channel: string | null;
  startedAt: string;
  lang: Lang;
}) {
  const d = new Date(startedAt);
  const when = Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString(lang === "ar" ? "ar" : undefined, { day: "numeric", month: "short", year: "numeric" });
  return (
    <div
      role="separator"
      aria-label={seamLabel(channel, lang)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        margin: "10px 0",
        color: "var(--ink-3)",
        fontSize: 11,
      }}
    >
      <span style={{ flex: 1, height: 1, background: "var(--line)" }} />
      <span
        style={{
          padding: "3px 12px",
          border: "1px solid var(--line)",
          borderRadius: 999,
          background: "var(--bg-elev)",
          whiteSpace: "nowrap",
        }}
      >
        {seamLabel(channel, lang)}
        {when ? ` · ${when}` : ""}
      </span>
      <span style={{ flex: 1, height: 1, background: "var(--line)" }} />
    </div>
  );
}
