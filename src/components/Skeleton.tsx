import type { CSSProperties } from "react";

interface SkeletonProps {
  w?: number | string;
  h?: number | string;
  radius?: number;
  style?: CSSProperties;
}

/** Base pulsing placeholder block. Uses the existing `.pulse` keyframes in app.css. */
export function Skeleton({ w = "100%", h = 12, radius = 6, style }: SkeletonProps) {
  return (
    <div
      className="pulse"
      aria-hidden
      style={{
        width: w,
        height: h,
        borderRadius: radius,
        background: "var(--line-soft)",
        ...style,
      }}
    />
  );
}

/** Pre-shaped placeholder mimicking a conversation row (avatar + name + preview). */
export function ConvRowSkeleton() {
  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        padding: "12px 14px",
        borderBottom: "1px solid var(--line-soft)",
        alignItems: "center",
      }}
    >
      <Skeleton w={36} h={36} radius={18} />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
        <Skeleton h={11} w="55%" />
        <Skeleton h={10} w="85%" />
      </div>
      <Skeleton h={10} w={24} />
    </div>
  );
}

/** Pre-shaped placeholder mimicking a chat message bubble. */
export function MessageSkeleton({ side = "left" }: { side?: "left" | "right" }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: side === "right" ? "flex-end" : "flex-start",
        padding: "6px 14px",
      }}
    >
      <Skeleton h={32} w={`${40 + Math.floor(Math.random() * 30)}%`} radius={14} />
    </div>
  );
}

/** Pre-shaped placeholder mimicking a social post card. */
export function PostCardSkeleton() {
  return (
    <div
      style={{
        padding: 14,
        border: "1px solid var(--line-soft)",
        borderRadius: 12,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <Skeleton w={36} h={36} radius={18} />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
          <Skeleton h={11} w="40%" />
          <Skeleton h={9} w="25%" />
        </div>
      </div>
      <Skeleton h={10} w="92%" />
      <Skeleton h={10} w="78%" />
      <Skeleton h={180} w="100%" radius={8} />
      <div style={{ display: "flex", gap: 14 }}>
        <Skeleton h={10} w={40} />
        <Skeleton h={10} w={40} />
        <Skeleton h={10} w={40} />
      </div>
    </div>
  );
}

/** Pre-shaped placeholder mimicking a comment row. */
export function CommentSkeleton() {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
      <Skeleton w={28} h={28} radius={14} />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
        <Skeleton h={10} w="35%" />
        <Skeleton h={10} w="90%" />
      </div>
    </div>
  );
}
