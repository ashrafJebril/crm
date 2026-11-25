import type { ReactNode } from "react";
import type { Tx } from "@/lib/tx";
import type { AdCard as AdCardDto, Lang } from "@/lib/types";
import { AdLabelText } from "../inbox/CtwaChip";
import { AdCreative } from "./AdCreative";
import { adLabel, costPerConversationView, spendView, type FigureView, type SpendUnknownReason } from "./adsModel";

/** A figure: a value, or a muted Unknown with its reason as a tooltip (never 0, blank or a dash). */
export function Figure({ label, view, children }: { label: string; view?: FigureView; children?: ReactNode }) {
  return (
    <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
      <span style={{ fontSize: 11, color: "var(--ink-3)" }}>{label}</span>
      {view ? (
        <span
          title={view.title}
          style={{
            fontSize: 14,
            fontWeight: view.unknown ? 500 : 650,
            color: view.unknown ? "var(--ink-3)" : "var(--ink)",
            fontStyle: view.unknown ? "italic" : undefined,
            fontVariantNumeric: "tabular-nums",
            textDecoration: view.title ? "underline dotted" : undefined,
            textUnderlineOffset: 3,
          }}
        >
          <bdi>{view.text}</bdi>
        </span>
      ) : (
        <span style={{ fontSize: 14, fontWeight: 650, fontVariantNumeric: "tabular-nums" }}>{children}</span>
      )}
    </div>
  );
}

export function AdCard({
  card,
  reason,
  tx,
  lang,
  onOpen,
}: {
  card: AdCardDto;
  reason: SpendUnknownReason;
  tx: Tx;
  lang: Lang;
  onOpen: (id: string) => void;
}) {
  const label = adLabel(card, tx);
  const headline = card.headline?.trim();
  return (
    <article
      style={{
        display: "grid",
        gridTemplateColumns: "auto 1fr",
        gap: 12,
        padding: 14,
        border: "1px solid var(--line-soft)",
        borderRadius: 12,
        background: "var(--bg-1)",
        minWidth: 0,
      }}
    >
      <AdCreative imageUrl={card.imageUrl} mediaType={card.mediaType} size={64} alt={headline ?? ""} />
      <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 650, fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            <AdLabelText label={label} />
          </div>
          {headline && label.kind !== "headline" && (
            <div dir="auto" style={{ fontSize: 12, color: "var(--ink-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "start" }}>
              {headline}
            </div>
          )}
          {card.campaignName && (
            <div dir="auto" style={{ fontSize: 11, color: "var(--ink-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "start" }}>
              {card.campaignName}
              {card.adSetName ? ` · ${card.adSetName}` : ""}
            </div>
          )}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
          <Figure label={tx("Started", "بدأت")}>
            <bdi>{new Intl.NumberFormat("en-US").format(card.started)}</bdi>
          </Figure>
          <Figure label={tx("Spend", "الإنفاق")} view={spendView(card.spend, tx, lang, reason)} />
          <Figure label={tx("Per conversation", "لكل محادثة")} view={costPerConversationView(card, tx, lang, reason)} />
        </div>
        <div>
          <button type="button" className="btn sm" onClick={() => onOpen(card.id)}>
            {tx("View conversations", "عرض المحادثات")}
          </button>
        </div>
      </div>
    </article>
  );
}
