import { useEffect, useRef } from "react";
import type { Tx } from "@/lib/tx";
import type { CopilotSourceCard, PendingCard } from "@/lib/types";
import { openRecord } from "@/lib/openRecord";
import type { ChatItem, ChatState } from "./chatReducer";
import { ConfirmCard } from "./ConfirmCard";
import { renderMarkdownLite, safeLinkHref } from "./markdownLite";
import { copilotKeyText, RETRYABLE_STREAM_CODES } from "./copilotErrors";
import { offerReplyDraft } from "./replyDraft";
import { noteText } from "./cardText";

/**
 * SP-18 the conversation in the drawer. Answers render through the markdown
 * subset (React elements only); the member's own text, notes and anything a
 * customer wrote render as plain text (`dir="auto"`); record names in `<bdi>`.
 */
export function MessageList({
  state,
  tx,
  lang,
  onCard,
  onStale,
  onRetry,
  onNewChat,
}: {
  state: ChatState;
  tx: Tx;
  lang: "en" | "ar";
  onCard: (c: PendingCard) => void;
  onStale: () => void;
  onRetry: () => void;
  onNewChat: () => void;
}) {
  const end = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [state.items.length, state.activity]);
  const lastError = [...state.items].reverse().find((i) => i.type === "error");
  const lastIsError = state.items[state.items.length - 1]?.type === "error";

  return (
    <div className="copilot-messages" aria-live="polite">
      {state.items.map((item) => (
        <Item key={`${item.type}-${item.id}`} item={item} state={state} tx={tx} lang={lang} onCard={onCard} onStale={onStale} />
      ))}
      {state.running && (
        <div className="copilot-activity" role="status">
          {state.activity ?? tx("Thinking…", "يفكّر…")}
        </div>
      )}
      {!state.running && lastIsError && lastError?.type === "error" && RETRYABLE_STREAM_CODES.has(lastError.code) && (
        <div className="copilot-card-actions">
          <button type="button" className="btn sm" onClick={onRetry}>
            {tx("Try again", "حاول مرة أخرى")}
          </button>
          {lastError.code === "copilot.attachment_unavailable" && (
            <button type="button" className="btn ghost sm" onClick={onNewChat}>
              {tx("Start a new chat", "ابدأ محادثة جديدة")}
            </button>
          )}
        </div>
      )}
      <div ref={end} />
    </div>
  );
}

function Item({ item, state, tx, lang, onCard, onStale }: { item: ChatItem; state: ChatState; tx: Tx; lang: "en" | "ar"; onCard: (c: PendingCard) => void; onStale: () => void }) {
  switch (item.type) {
    case "user":
      return (
        <div className="copilot-msg copilot-user">
          {(item.references.length > 0 || item.attachments.length > 0) && (
            <div className="copilot-chips">
              {item.references.map((r) => (
                <span key={`${r.kind}:${r.id}`} className="copilot-chip">
                  @<bdi>{r.title}</bdi>
                </span>
              ))}
              {item.attachments.map((a) => (
                <span key={a.id} className="copilot-chip">
                  📎 <bdi>{a.fileName}</bdi>
                </span>
              ))}
            </div>
          )}
          <div dir="auto" style={{ whiteSpace: "pre-wrap" }}>
            {item.text}
          </div>
        </div>
      );
    case "assistant":
      return (
        <div className="copilot-msg copilot-assistant" dir="auto">
          <div className="copilot-md">{renderMarkdownLite(item.text)}</div>
          {item.sources.length > 0 && <SourceCards sources={item.sources} tx={tx} />}
        </div>
      );
    case "note":
      return (
        <div className="copilot-note" dir="auto">
          {noteText(item.text, tx)}
        </div>
      );
    case "error":
      return (
        <div className="copilot-error" role="alert">
          {copilotKeyText(item.code, tx)}
        </div>
      );
    case "card": {
      const card = state.cards[item.id];
      return card ? <ConfirmCard card={card} tx={tx} lang={lang} onChanged={onCard} onStale={onStale} /> : null;
    }
    case "draft":
      return <DraftCard conversationId={item.conversationId} text={item.text} tx={tx} />;
  }
}

/** A reply draft: "Copy to reply box" opens the conversation and fills its composer. It never sends. */
export function DraftCard({ conversationId, text, tx }: { conversationId: string; text: string; tx: Tx }) {
  return (
    <div className="copilot-card copilot-draft">
      <div className="copilot-card-title">{tx("Reply draft (not sent)", "مسودة رد (لم تُرسل)")}</div>
      <div dir="auto" style={{ whiteSpace: "pre-wrap" }}>
        {text}
      </div>
      <div className="copilot-card-actions">
        <button
          type="button"
          className="btn primary sm"
          onClick={() => {
            offerReplyDraft(conversationId, text);
            window.location.hash = `#/inbox?open=${encodeURIComponent(conversationId)}`;
          }}
        >
          {tx("Copy to reply box", "انسخ إلى مربع الرد")}
        </button>
      </div>
    </div>
  );
}

/** "Based on": records open the record sheet (as the member); knowledge opens its link or the knowledge page. */
export function SourceCards({ sources, tx }: { sources: CopilotSourceCard[]; tx: Tx }) {
  return (
    <div className="copilot-sources">
      <span className="copilot-sources-label">{tx("Based on", "بالاستناد إلى")}</span>
      {sources.map((s) =>
        s.kind === "record" ? (
          <button key={`r:${s.recordKind}:${s.id}`} type="button" className="copilot-chip" onClick={() => openRecord(s.recordKind, s.id)}>
            <bdi>{s.title}</bdi>
          </button>
        ) : (
          <a
            key={`k:${s.sourceId}`}
            className="copilot-chip"
            href={(s.url && safeLinkHref(s.url)) || "#/agent"}
            {...(s.url && safeLinkHref(s.url) ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          >
            <bdi>{s.title}</bdi>
          </a>
        ),
      )}
    </div>
  );
}
