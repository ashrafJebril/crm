import { useEffect, useMemo, useState } from "react";
import { useFetch } from "@/api/useFetch";
import { usePermissions } from "@/auth/usePermissions";
import { PageHeader } from "@/components/PageHeader";
import { Skeleton } from "@/components/Skeleton";
import { useHashParam } from "@/lib/useHashParam";
import { makeTx, type Tx } from "@/lib/tx";
import type { AdsOverview, Lang } from "@/lib/types";
import { TITLES } from "@/shell/nav";
import { useTweaks } from "@/tweaks/context";
import { Banner } from "../channels/channelUi";
import { AdCard, Figure } from "./AdCard";
import { AdDetail } from "./AdDetail";
import { AdsDailyChart } from "./AdsDailyChart";
import { adsErrorText } from "./adsErrors";
import {
  dailyCurrencies,
  emptyStateText,
  overviewDaily,
  parseRange,
  presetLabel,
  RANGE_PRESETS,
  rangeQueryString,
  rangeToQuery,
  spendUnknownReason,
  totalsView,
  unknownReasonText,
  writeRange,
  type AdsRange,
} from "./adsModel";
import { MetaAdsConnect, useStartOAuth } from "./MetaAdsConnect";

/** The range in the hash (`range`, `from`, `to`), kept in sync with hashchange. */
function useRange(): [AdsRange, (r: AdsRange) => void] {
  const [range, setRangeState] = useState<AdsRange>(() => parseRange(window.location.hash));
  useEffect(() => {
    const on = () => setRangeState(parseRange(window.location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const set = (r: AdsRange) => {
    const next = writeRange(window.location.hash, r);
    if (next !== window.location.hash) window.location.hash = next;
    setRangeState(parseRange(next));
  };
  return [range, set];
}

/**
 * SP-15 Ads screen (`#/ads`): click-to-WhatsApp ads, the conversations they
 * started, their Meta-reported spend and cost per conversation, a per-ad
 * page (`?ad=<id>`) and the Meta Ads connection (`?tab=connection`).
 *
 * The Salma ads-chat backend (`backend/src/ads`) is untouched; its UI is
 * deferred to SP-18 (ruling R11).
 */
export default function AdsPage() {
  const { t } = useTweaks();
  const lang = t.lang;
  // Stable per language: AdDetail's conversation list reloads when `tx` changes (review M3).
  const tx = useMemo(() => makeTx(lang), [lang]);
  const { can, loading: permsLoading } = usePermissions();
  const canView = can("reports.view");
  const canConnView = can("connectors.view");
  const canManage = can("connectors.manage");
  const [tabParam, setTab] = useHashParam("tab");
  const [adId, setAdId] = useHashParam("ad");
  const tab = canConnView && tabParam === "connection" ? "connection" : "overview";
  const [range, setRange] = useRange();
  const query = useMemo(() => rangeToQuery(range), [range]);
  // The per-ad page words Unknown spend from the connection state: the overview's
  // (same path as the Overview tab, so it is one shared cached request).
  const detailOverview = useFetch<AdsOverview>(canView && adId ? `/ad-sources/overview?${rangeQueryString(query)}` : null);

  if (permsLoading) {
    return (
      <div style={{ padding: 24 }}>
        <Skeleton h={200} radius={12} />
      </div>
    );
  }
  if (!canView) {
    return (
      <div style={{ padding: 24 }}>
        <PageHeader title={tx(TITLES.ads.en, TITLES.ads.ar)} />
        <div className="muted" style={{ padding: "0 24px", fontSize: 13 }}>
          {tx("You don't have permission to view ads.", "ليست لديك صلاحية لعرض الإعلانات.")}
        </div>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflowY: "auto" }}>
      <PageHeader
        title={tx(TITLES.ads.en, TITLES.ads.ar)}
        subtitle={tx(
          "Conversations your click-to-WhatsApp ads started, what they spent and what each conversation cost.",
          "المحادثات التي بدأتها إعلانات النقر للمراسلة على واتساب، وما أنفقته، وتكلفة كل محادثة.",
        )}
      />
      <div style={{ padding: "4px 24px 32px", display: "grid", gap: 14, maxWidth: 1180 }}>
        {adId ? (
          <AdDetail
            adId={adId}
            query={query}
            connection={detailOverview.data?.connection ?? null}
            range={detailOverview.data?.range ?? null}
            tx={tx}
            lang={lang}
            onBack={() => setAdId(null)}
            key={adId}
          />
        ) : (
          <>
            {canConnView && (
              <div
                role="tablist"
                aria-label={tx("View", "العرض")}
                style={{ display: "inline-flex", gap: 4, justifySelf: "start", padding: 3, borderRadius: 9, background: "var(--bg-2)", border: "1px solid var(--line-soft)" }}
              >
                {(
                  [
                    ["overview", tx("Overview", "نظرة عامة")],
                    ["connection", tx("Connection", "الربط")],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={tab === key}
                    className={`btn sm ${tab === key ? "" : "ghost"}`.trim()}
                    onClick={() => setTab(key === "connection" ? "connection" : null)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            {tab === "connection" ? (
              <MetaAdsConnect tx={tx} lang={lang} canManage={canManage} />
            ) : (
              <Overview
                range={range}
                setRange={setRange}
                query={query}
                tx={tx}
                lang={lang}
                canManage={canManage}
                onOpenAd={(id) => setAdId(id)}
                onOpenConnection={() => setTab("connection")}
                canConnView={canConnView}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function RangePicker({ range, setRange, tz, tx }: { range: AdsRange; setRange: (r: AdsRange) => void; tz: string | null; tx: Tx }) {
  const q = rangeToQuery(range);
  const [from, setFrom] = useState(q.from);
  const [to, setTo] = useState(q.to);
  useEffect(() => {
    setFrom(q.from);
    setTo(q.to);
  }, [q.from, q.to]);
  const applyCustom = (f: string, t: string) => {
    if (f && t && f <= t) setRange({ preset: "custom", from: f, to: t });
  };
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
      <div role="group" aria-label={tx("Date range", "نطاق التاريخ")} style={{ display: "inline-flex", gap: 4 }}>
        {RANGE_PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            className={`btn sm ${range.preset === p ? "" : "ghost"}`.trim()}
            aria-pressed={range.preset === p}
            onClick={() => setRange({ preset: p })}
          >
            {presetLabel(p, tx)}
          </button>
        ))}
      </div>
      <div style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
        <input
          type="date"
          aria-label={tx("From date", "من تاريخ")}
          value={from}
          max={to || undefined}
          onChange={(e) => {
            setFrom(e.target.value);
            applyCustom(e.target.value, to);
          }}
        />
        <span aria-hidden className="muted">–</span>
        <input
          type="date"
          aria-label={tx("To date", "إلى تاريخ")}
          value={to}
          min={from || undefined}
          onChange={(e) => {
            setTo(e.target.value);
            applyCustom(from, e.target.value);
          }}
        />
      </div>
      {tz && (
        <span className="muted" style={{ fontSize: 11.5 }}>
          {tx("Days in ", "الأيام بتوقيت ")}
          <bdi dir="ltr">{tz}</bdi>
        </span>
      )}
    </div>
  );
}

function Overview({
  range,
  setRange,
  query,
  tx,
  lang,
  canManage,
  canConnView,
  onOpenAd,
  onOpenConnection,
}: {
  range: AdsRange;
  setRange: (r: AdsRange) => void;
  query: { from: string; to: string };
  tx: Tx;
  lang: Lang;
  canManage: boolean;
  canConnView: boolean;
  onOpenAd: (id: string) => void;
  onOpenConnection: () => void;
}) {
  const q = useFetch<AdsOverview>(`/ad-sources/overview?${rangeQueryString(query)}`);
  const o = q.data;
  const oauth = useStartOAuth(tx);
  const reason = spendUnknownReason(o?.connection, o?.range);
  const totals = o ? totalsView(o, tx, lang) : null;
  const currencies = o ? dailyCurrencies(o.daily) : [];
  const conn = o?.connection ?? null;
  const notConnected = o && (!conn || conn.status === "not_connected" || conn.status === "disconnected" || conn.status === "pending");

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <RangePicker range={range} setRange={setRange} tz={o?.range.tz ?? null} tx={tx} />

      {notConnected && (
        <Banner
          tone="info"
          title={tx("Spend is Unknown until Meta Ads is connected", "الإنفاق غير معروف حتى تُربط إعلانات Meta")}
          action={
            canManage ? (
              <button type="button" className="btn primary sm" onClick={oauth.start} disabled={oauth.busy}>
                {tx("Connect", "ربط")}
              </button>
            ) : undefined
          }
        >
          {tx(
            "Conversations from ads are counted already. Connect your Meta ad account to see spend and cost per conversation.",
            "تُحتسب المحادثات من الإعلانات بالفعل. اربط حسابك الإعلاني في Meta لعرض الإنفاق والتكلفة لكل محادثة.",
          )}
        </Banner>
      )}
      {oauth.error && <Banner tone="bad">{oauth.error.text}</Banner>}
      {conn?.status === "needs_reconnect" && (
        <Banner
          tone="bad"
          title={tx("Meta Ads needs reconnecting", "إعلانات Meta تحتاج إلى إعادة ربط")}
          action={
            canConnView ? (
              <button type="button" className="btn sm" onClick={onOpenConnection}>
                {tx("Open connection", "فتح الربط")}
              </button>
            ) : undefined
          }
        >
          {tx("New spend shows as Unknown until it is reconnected.", "يظهر الإنفاق الجديد غير معروف حتى تُعاد عملية الربط.")}
        </Banner>
      )}
      {conn?.status === "active" && !conn.lastSyncedAt && (
        <Banner tone="info">
          {tx("First sync pending: spend appears within the hour.", "المزامنة الأولى قيد الانتظار: يظهر الإنفاق خلال ساعة.")}
        </Banner>
      )}

      {q.error && !o && <Banner tone="bad">{adsErrorText(q.error, tx)}</Banner>}
      {!o && !q.error && <Skeleton h={220} radius={12} />}

      {o && totals && (
        <>
          <section
            aria-label={tx("Totals", "الإجماليات")}
            style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}
          >
            <div style={{ padding: 14, border: "1px solid var(--line-soft)", borderRadius: 12, background: "var(--bg-1)" }}>
              <Figure label={tx("Conversations started", "المحادثات التي بدأت")}>
                <span style={{ fontSize: 24 }}>
                  <bdi>{new Intl.NumberFormat("en-US").format(totals.started)}</bdi>
                </span>
              </Figure>
            </div>
            {totals.figures.map((f) => (
              <div
                key={f.currency ?? "unknown"}
                style={{ padding: 14, border: "1px solid var(--line-soft)", borderRadius: 12, background: "var(--bg-1)", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}
              >
                <Figure label={f.currency ? tx(`Spend (${f.currency})`, `الإنفاق (${f.currency})`) : tx("Spend", "الإنفاق")} view={f.spend} />
                <Figure label={tx("Cost per conversation", "التكلفة لكل محادثة")} view={f.cost} />
              </div>
            ))}
          </section>

          {o.ads.length === 0 ? (
            <div style={{ padding: 32, textAlign: "center", border: "1px dashed var(--line)", borderRadius: 12 }}>
              <div style={{ fontWeight: 650, fontSize: 14 }}>{emptyStateText(!!o.everReferred, tx)}</div>
              <div className="muted" style={{ fontSize: 12.5, marginBlockStart: 4 }}>
                {o.everReferred
                  ? tx("Pick a longer range to see earlier ads.", "اختر نطاقًا أطول لعرض الإعلانات السابقة.")
                  : tx(
                      "When someone messages you from a click-to-WhatsApp ad, the ad and its conversations appear here.",
                      "عندما يراسلك أحد من إعلان نقر للمراسلة على واتساب، يظهر الإعلان ومحادثاته هنا.",
                    )}
              </div>
            </div>
          ) : (
            <>
              <section style={{ padding: 16, border: "1px solid var(--line-soft)", borderRadius: 12, background: "var(--bg-1)", display: "grid", gap: 16 }}>
                {(currencies.length ? currencies : [null]).map((cur) => (
                  <AdsDailyChart
                    key={cur ?? "none"}
                    daily={overviewDaily(o.daily, cur)}
                    currency={cur}
                    spendUnknownText={unknownReasonText(reason, tx)}
                    tx={tx}
                    lang={lang}
                  />
                ))}
              </section>
              <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: 12 }}>
                {o.ads.map((c) => (
                  <AdCard key={c.id} card={c} reason={spendUnknownReason(o.connection, o.range, c)} tx={tx} lang={lang} onOpen={onOpenAd} />
                ))}
              </section>
              {o.totalAds > o.ads.length && (
                <div className="muted" style={{ fontSize: 12 }}>
                  {tx(`Showing the top ${o.ads.length} of ${o.totalAds} ads.`, `عرض أعلى ${o.ads.length} من ${o.totalAds} إعلانًا.`)}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
