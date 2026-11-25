import type { Tx } from "@/lib/tx";
import type { AdSourceChip, Lang } from "@/lib/types";
import { AdCreative } from "../ads/AdCreative";
import { adLabel, type AdLabel } from "../ads/adsModel";

/** The label text; an id label puts the id in <bdi> (it is Latin inside an Arabic sentence). */
export function AdLabelText({ label }: { label: AdLabel }) {
  if (label.kind === "id") {
    return (
      <span>
        {label.prefix} <bdi className="mono">{label.text}</bdi>
      </span>
    );
  }
  return <bdi dir="auto">{label.text}</bdi>;
}

/**
 * SP-15: a compact "Ad · <label>" chip for inbox list and table rows. The
 * creative shows only when the chip has an image URL.
 */
export function CtwaChip({ ad, tx }: { ad: AdSourceChip; tx: Tx }) {
  const label = adLabel(ad, tx);
  const title = label.kind === "id" ? `${label.prefix} ${label.text}` : label.text;
  return (
    <span
      title={tx(`From ad: ${title}`, `من إعلان: ${title}`)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        maxWidth: "100%",
        padding: "1px 6px 1px 2px",
        paddingInlineStart: ad.imageUrl ? 2 : 6,
        borderRadius: 99,
        border: "1px solid color-mix(in oklch, var(--info) 35%, transparent)",
        background: "color-mix(in oklch, var(--info) 9%, transparent)",
        color: "var(--ink-2)",
        fontSize: 11,
        lineHeight: "16px",
        verticalAlign: "middle",
      }}
    >
      {ad.imageUrl && <AdCreative imageUrl={ad.imageUrl} mediaType={ad.mediaType} size={14} radius={99} />}
      <span style={{ fontWeight: 700, color: "var(--info)", flexShrink: 0 }}>{tx("Ad", "إعلان")}</span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
        {label.kind === "id" ? <bdi className="mono">{label.text}</bdi> : <bdi dir="auto">{label.text}</bdi>}
      </span>
    </span>
  );
}

const fmtDate = (iso: string | null | undefined, lang: Lang): string | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleDateString(lang === "ar" ? "ar-u-nu-latn" : "en-US", { dateStyle: "medium" });
};

/**
 * SP-15: the thread-header attribution card: creative, headline, "From ad ·
 * <date>", and a link to the ad's page for reports.view holders.
 */
export function AdAttributionCard({
  ad,
  referredAt,
  canOpen,
  tx,
  lang,
}: {
  ad: AdSourceChip;
  referredAt: string | null | undefined;
  canOpen: boolean;
  tx: Tx;
  lang: Lang;
}) {
  const label = adLabel(ad, tx);
  const date = fmtDate(referredAt, lang);
  const headline = ad.headline?.trim();
  return (
    <div
      role="note"
      aria-label={tx("Ad attribution", "مصدر الإعلان")}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 20px",
        borderBottom: "1px solid var(--line-soft)",
        background: "color-mix(in oklch, var(--info) 5%, var(--bg-1))",
        fontSize: 12.5,
      }}
    >
      {ad.imageUrl && <AdCreative imageUrl={ad.imageUrl} mediaType={ad.mediaType} size={36} radius={6} alt={headline ?? ""} />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {headline && label.kind !== "headline" ? (
            <>
              <AdLabelText label={label} />
              <span style={{ color: "var(--ink-3)", fontWeight: 400 }}> · </span>
              <bdi dir="auto" style={{ fontWeight: 400 }}>{headline}</bdi>
            </>
          ) : (
            <AdLabelText label={label} />
          )}
        </div>
        <div style={{ color: "var(--ink-3)", fontSize: 11.5, marginBlockStart: 1 }}>
          {date ? (
            <>
              {tx("From ad", "من إعلان")} · <bdi>{date}</bdi>
            </>
          ) : (
            tx("From ad", "من إعلان")
          )}
        </div>
      </div>
      {canOpen && (
        <a className="btn sm" href={`#/ads?ad=${encodeURIComponent(ad.id)}`}>
          {tx("View ad", "عرض الإعلان")}
        </a>
      )}
    </div>
  );
}
