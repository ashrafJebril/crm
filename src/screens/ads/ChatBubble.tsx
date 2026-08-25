import { lazy, Suspense } from "react";
import type { AdsChatRole } from "@/api/ads";

// Lazy so react-markdown + remark-gfm split into their OWN async chunk, loaded
// only when an assistant bubble first renders — never in the main bundle.
const AssistantMarkdown = lazy(() => import("./AssistantMarkdown"));

interface BubbleProps {
  role: AdsChatRole;
  text: string;
  time: string;
  /** Dimmed while an optimistic user bubble is still in flight. */
  muted?: boolean;
}

/** One thread message. The viewer's own turns sit on the end side in gold-tinted
 *  `--bubble-out`, Salma's on the start side in `--bubble-in` — the same
 *  in/out convention (and the same tokens) as the Inbox thread. */
export function ChatBubble({ role, text, time, muted }: BubbleProps) {
  const isUser = role === "user";
  return (
    <div style={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start" }}>
      <div className={`ads-bubble ${isUser ? "out" : "in"}`} style={{ opacity: muted ? 0.7 : 1 }}>
        {isUser ? (
          // User messages stay PLAIN TEXT — no markdown parsing, so anything
          // they typed renders exactly as typed.
          <div dir="auto" style={{ whiteSpace: "pre-wrap" }}>
            {text}
          </div>
        ) : (
          // Assistant → markdown (GFM tables/bold/headings/lists/inline code).
          // The fallback keeps the raw reply readable during the one-time chunk
          // load instead of flashing an empty bubble.
          <Suspense
            fallback={
              <div dir="auto" style={{ whiteSpace: "pre-wrap" }}>
                {text}
              </div>
            }
          >
            <AssistantMarkdown text={text} />
          </Suspense>
        )}
        <div className="stamp">
          <span dir="ltr">{time}</span>
        </div>
      </div>
    </div>
  );
}

/** "Salma is typing…" placeholder — shown only while a chat request is open. */
export function TypingBubble({ label }: { label: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-start" }}>
      <div className="ads-typing">{label}</div>
    </div>
  );
}
