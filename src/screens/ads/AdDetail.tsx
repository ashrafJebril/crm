import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import { useFetch } from "@/api/useFetch";
import { usePermissions } from "@/auth/usePermissions";
import { Skeleton } from "@/components/Skeleton";
import type { Tx } from "@/lib/tx";
import type { AdCard as AdCardDto, AdConversationItem, AdsOverview, Lang, MetaAdsConnectionDto } from "@/lib/types";
import { Banner, ErrorText } from "../channels/channelUi";
import { AdLabelText } from "../inbox/CtwaChip";
import { Figure } from "./AdCard";
import { AdCreative } from "./AdCreative";
import { AdsDailyChart } from "./AdsDailyChart";
import { adsErrorText } from "./adsErrors";
import {
  adLabel,
  costPerConversationView,
  rangeQueryString,
  spendUnknownReason,
  spendView,
  unknownReasonText,
} from "./adsModel";

const fmtWhen = (iso: string | null | undefined, lang: Lang) => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t)
    ? null
    : new Date(t).toLocaleString(lang === "ar" ? "ar-u-nu-latn" : "en-US", { dateStyle: "medium", timeStyle: "short" });
};

/** SP-15 per-ad page (`#/ads?ad=<id>`): the card, its daily chart, the full body, and its conversations. */
export function AdDetail({
  adId,
  query,
  connection,
  range,
  tx,
  lang,
  onBack,
}: {
  adId: string;
  query: { from: string; to: string };
  /** From the overview (same range): words an Unknown spend. */
  connection: MetaAdsConnectionDto | null;
  range: AdsOverview["range"] | null;
  tx: Tx;
  lang: Lang;
  onBack: () => void;
}) {
  const { can } = usePermissions();
  const canConversations = can("conversations.view");
  const qs = rangeQueryString(query);
  const cardQ = useFetch<AdCardDto>(`/ad-sources/${encodeURIComponent(adId)}?${qs}`);
  const card = cardQ.data;
  const reason = spendUnknownReason(connection, range, card ?? null);

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div>
        <button type="button" className="btn ghost sm" onClick={onBack}>
          {lang === "ar" ? "→" : "←"} {tx("All ads", "كل الإعلانات")}
        </button>
      </div>
      {cardQ.error && !card && <Banner tone="bad">{adsErrorText(cardQ.error, tx)}</Banner>}
      {!card && !cardQ.error && <Skeleton h={160} radius={12} />}
      {card && (
        <>
          <section
            style={{
              display: "grid",
              gridTemplateColumns: "auto 1fr",
              gap: 16,
              padding: 16,
              border: "1px solid var(--line-soft)",
              borderRadius: 12,
              background: "var(--bg-1)",
            }}
          >
            <AdCreative imageUrl={card.imageUrl} mediaType={card.mediaType} size={120} radius={10} alt={card.headline ?? ""} />
            <div style={{ display: "grid", gap: 10, minWidth: 0, alignContent: "start" }}>
              <div>
                <h2 style={{ fontSize: 17, margin: 0, fontWeight: 700 }}>
                  <AdLabelText label={adLabel(card, tx)} />
                </h2>
                {card.headline && (
                  <div dir="auto" style={{ fontSize: 13, color: "var(--ink-2)", textAlign: "start", marginBlockStart: 2 }}>
                    {card.headline}
                  </div>
                )}
                <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginBlockStart: 4 }}>
                  {tx("Ad id", "معرّف الإعلان")} <bdi className="mono">{card.sourceId}</bdi>
                  {card.adAccountId && (
                    <>
                      {" · "}
                      {tx("Account", "الحساب")} <bdi className="mono">{card.adAccountId}</bdi>
                    </>
                  )}
                  {card.campaignName && (
                    <>
                      {" · "}
                      <bdi dir="auto">{card.campaignName}</bdi>
                    </>
                  )}
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10 }}>
                <Figure label={tx("Conversations started", "المحادثات التي بدأت")}>
                  <bdi>{new Intl.NumberFormat("en-US").format(card.started)}</bdi>
                </Figure>
                <Figure label={tx("Spend", "الإنفاق")} view={spendView(card.spend, tx, lang, reason)} />
                <Figure label={tx("Cost per conversation", "التكلفة لكل محادثة")} view={costPerConversationView(card, tx, lang, reason)} />
              </div>
              {card.sourceUrl && /^https:\/\//i.test(card.sourceUrl) && (
                <div>
                  <a className="btn sm" href={card.sourceUrl} target="_blank" rel="noopener noreferrer">
                    {tx("Open ad", "فتح الإعلان")}
                  </a>
                </div>
              )}
            </div>
          </section>

          {card.daily && card.daily.length > 0 && (
            <section style={{ padding: 16, border: "1px solid var(--line-soft)", borderRadius: 12, background: "var(--bg-1)" }}>
              <AdsDailyChart
                daily={card.daily}
                currency={card.spend?.currency ?? null}
                spendUnknownText={unknownReasonText(reason, tx)}
                tx={tx}
                lang={lang}
              />
            </section>
          )}

          {card.body && (
            <section style={{ padding: 16, border: "1px solid var(--line-soft)", borderRadius: 12, background: "var(--bg-1)", display: "grid", gap: 6 }}>
              <div style={{ fontSize: 12, color: "var(--ink-3)", fontWeight: 600 }}>{tx("Ad text", "نص الإعلان")}</div>
              {card.body && (
                <div dir="auto" style={{ fontSize: 13, whiteSpace: "pre-wrap", textAlign: "start", lineHeight: 1.55 }}>
                  {card.body}
                </div>
              )}
            </section>
          )}

          {canConversations && <AdConversations adId={adId} qs={qs} tx={tx} lang={lang} />}
        </>
      )}
    </div>
  );
}

function AdConversations({ adId, qs, tx, lang }: { adId: string; qs: string; tx: Tx; lang: Lang }) {
  const [items, setItems] = useState<AdConversationItem[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // `tx` only words errors: read it from a ref so a new `tx` never reloads the list (review M3).
  const txRef = useRef(tx);
  txRef.current = tx;

  const load = useCallback(
    async (cursor: string | null, signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const path = `/ad-sources/${encodeURIComponent(adId)}/conversations?${qs}&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const r = await api.get<{ items: AdConversationItem[]; nextCursor: string | null }>(path, signal);
        if (signal?.aborted) return;
        setItems((prev) => (cursor ? [...prev, ...r.items] : r.items));
        setNext(r.nextCursor);
      } catch (e) {
        if (signal?.aborted) return;
        setError(adsErrorText(e, txRef.current));
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [adId, qs],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    setItems([]);
    setNext(null);
    void load(null, ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  return (
    <section style={{ padding: 16, border: "1px solid var(--line-soft)", borderRadius: 12, background: "var(--bg-1)", display: "grid", gap: 8 }}>
      <div style={{ fontSize: 13, fontWeight: 650 }}>{tx("Conversations from this ad", "المحادثات من هذا الإعلان")}</div>
      {items.length === 0 && !loading && !error && (
        <div className="muted" style={{ fontSize: 12.5 }}>
          {tx("No conversations from this ad in this range.", "لا محادثات من هذا الإعلان في هذا النطاق.")}
        </div>
      )}
      {items.length > 0 && (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid" }}>
          {items.map((it, i) => (
            <li key={`${it.conversationId}:${it.referredAt}:${i}`} style={{ borderTop: i ? "1px solid var(--line-soft)" : undefined }}>
              <a
                href={`#/inbox?open=${encodeURIComponent(it.conversationId)}`}
                style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 2px", color: "inherit", textDecoration: "none" }}
              >
                <span dir="auto" style={{ flex: 1, minWidth: 0, fontWeight: 600, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {it.contactName || tx("Unnamed contact", "جهة اتصال بلا اسم")}
                </span>
                {it.firstTouch && (
                  <span style={{ fontSize: 10.5, color: "var(--info)", border: "1px solid color-mix(in oklch, var(--info) 35%, transparent)", borderRadius: 99, padding: "0 6px" }}>
                    {tx("First touch", "أول تواصل")}
                  </span>
                )}
                <bdi style={{ fontSize: 11.5, color: "var(--ink-3)", whiteSpace: "nowrap" }}>{fmtWhen(it.referredAt, lang)}</bdi>
              </a>
            </li>
          ))}
        </ul>
      )}
      {loading && <Skeleton h={28} />}
      <ErrorText>{error}</ErrorText>
      {next && !loading && (
        <div>
          <button type="button" className="btn sm" onClick={() => void load(next)}>
            {tx("Load more", "تحميل المزيد")}
          </button>
        </div>
      )}
    </section>
  );
}
