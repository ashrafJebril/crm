import { useMemo, useState } from "react";
import { useAuth } from "@/auth/context";
import { useFetch } from "@/api/useFetch";
import { api } from "@/api/client";
import { billingLink } from "@/lib/paymentLock";
import { makeTx, type Tx } from "@/lib/tx";
import type { BillingCatalog, BillingDailyUsage, BillingLedgerItem, BillingLedgerPage, BillingMeter, BillingStatus, Lang } from "@/lib/types";
import { useTweaks } from "@/tweaks/context";
import {
  FEATURE_COPY,
  METER_COPY,
  METERS,
  countdownText,
  featureLabel,
  fillDays,
  formatCount,
  formatJod,
  ledgerTypeLabel,
  planCardView,
  planLabel,
  usageText,
} from "@/screens/billing/billingModel";
import { billingErrorText } from "@/screens/billing/billingErrors";
import { useBillingStatus } from "@/screens/billing/useBillingStatus";
import { SettingsCard } from "./form";

const DAY_MS = 86_400_000;
const RANGE_DAYS = 30;

/** A local day (YYYY-MM-DD) in the workspace timezone. */
function localDay(at: Date, tz: string | null | undefined): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz || "Asia/Riyadh", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

function shortDay(day: string, lang: Lang): string {
  const d = new Date(`${day}T00:00:00Z`);
  return new Intl.DateTimeFormat(lang === "ar" ? "ar-u-nu-latn-ca-gregory" : "en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(d);
}

function dateTime(iso: string, tz: string | null | undefined, lang: Lang): string {
  try {
    return new Intl.DateTimeFormat(lang === "ar" ? "ar-u-nu-latn-ca-gregory" : "en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: tz || undefined,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/**
 * SP-28 Settings → Billing (billing.view), read-only: Kewy/Joteck bills the
 * workspace, so this shows the plan and payment state from Kewy, usage per
 * meter with a daily chart, and the wallet balance and ledger. No checkout,
 * invoices, payment method, top-up or trials. Unset prices, allowances and
 * seats stay hidden (R3).
 */
export function BillingTab() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const lang = t.lang;
  const { activeWorkspace } = useAuth();
  const tz = activeWorkspace?.timezone;
  const statusQ = useBillingStatus();
  const catalogQ = useFetch<BillingCatalog>("/billing/catalog");
  const status = statusQ.data;
  const kewyUrl = billingLink();

  if (statusQ.error && !status) {
    return (
      <SettingsCard title={tx("Billing", "الفوترة")}>
        <div role="alert" style={{ color: "var(--bad)", fontSize: 13 }}>
          {tx("Couldn't load billing. Try again.", "تعذّر تحميل الفوترة. حاول مرة أخرى.")}
        </div>
      </SettingsCard>
    );
  }
  if (!status) return <div className="muted">{tx("Loading…", "جارٍ التحميل…")}</div>;

  const myPlan = catalogQ.data?.plans.find((p) => p.key === status.plan.key);
  const card = myPlan ? planCardView(myPlan) : null;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <SettingsCard title={tx("Plan", "الباقة")}>
        <div style={{ display: "grid", gap: 10, fontSize: 13 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <strong style={{ fontSize: 16 }}>
              <bdi>{planLabel(status.plan, lang)}</bdi>
            </strong>
            {status.overridden && <span className="badge">{tx("Set by Kewy support", "عيّنها دعم كيوي")}</span>}
            <span className="muted" style={{ marginInlineStart: "auto" }}>
              {tx("Billed by Kewy", "تتم الفوترة عبر كيوي")}
            </span>
          </div>
          {card && (card.monthlyJod !== null || card.seats !== null || card.allowances.length > 0) && (
            <div className="muted" style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
              {card.monthlyJod !== null && (
                <span>
                  {tx("Monthly", "شهري")}: <bdi>{formatJod(card.monthlyJod, lang)}</bdi>
                </span>
              )}
              {card.seats !== null && (
                <span>
                  {tx("Seats", "المقاعد")}: <bdi>{formatCount(card.seats)}</bdi>
                </span>
              )}
            </div>
          )}
          {card && (
            <div className="muted">
              {tx("WhatsApp numbers", "أرقام واتساب")}: <bdi>{formatCount(card.whatsappNumbers)}</bdi>
            </div>
          )}
          <div>
            <div style={{ fontWeight: 600, marginBlockEnd: 4 }}>{tx("Included", "مشمول")}</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {Object.keys(FEATURE_COPY).map((f) => {
                const on = status.features.includes(f);
                return (
                  <span key={f} className="chip" style={{ opacity: on ? 1 : 0.5 }} title={on ? undefined : tx("Not in your plan", "غير متاح في باقتك")}>
                    {on ? "✓ " : ""}
                    {featureLabel(f, lang)}
                  </span>
                );
              })}
            </div>
          </div>
          {kewyUrl && (
            <a className="btn sm" href={kewyUrl} target="_blank" rel="noopener noreferrer" style={{ justifySelf: "start", textDecoration: "none" }}>
              {tx("Manage your plan in Kewy", "أدر باقتك عبر كيوي")}
            </a>
          )}
        </div>
      </SettingsCard>

      <PaymentCard status={status} tx={tx} lang={lang} tz={tz} />

      <UsageCard status={status} tx={tx} lang={lang} tz={tz} />

      <WalletCard status={status} tx={tx} lang={lang} tz={tz} />
    </div>
  );
}

function PaymentCard({ status, tx, lang, tz }: { status: BillingStatus; tx: Tx; lang: Lang; tz: string | null | undefined }) {
  const p = status.payment;
  return (
    <SettingsCard title={tx("Payment", "الدفع")}>
      {!p.dueSince ? (
        <div style={{ fontSize: 13 }}>{tx("Paid up. Nothing is due.", "لا توجد مستحقات.")}</div>
      ) : (
        <div role="alert" style={{ fontSize: 13, display: "grid", gap: 4 }}>
          <div style={{ color: "var(--bad)", fontWeight: 600 }}>{tx("A payment is due", "هناك دفعة مستحقة")}</div>
          <div>
            {tx("Due since", "مستحقة منذ")} <bdi>{dateTime(p.dueSince, tz, lang)}</bdi>
          </div>
          {p.locksAt && (
            <div>
              {(() => {
                const left = countdownText(p.locksAt, new Date());
                return tx(
                  `The workspace locks on ${dateTime(p.locksAt, tz, "en")} (in ${left[0]}) unless it is paid in Kewy.`,
                  `ستُقفل مساحة العمل في ${dateTime(p.locksAt, tz, "ar")} (خلال ${left[1]}) ما لم تُدفع عبر كيوي.`,
                );
              })()}
            </div>
          )}
        </div>
      )}
    </SettingsCard>
  );
}

function UsageCard({ status, tx, lang, tz }: { status: BillingStatus; tx: Tx; lang: Lang; tz: string | null | undefined }) {
  const [meter, setMeter] = useState<BillingMeter>("ai_reply");
  const range = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - (RANGE_DAYS - 1) * DAY_MS);
    return { from, to, fromDay: localDay(from, tz), toDay: localDay(to, tz) };
  }, [tz]);
  const dailyQ = useFetch<BillingDailyUsage>(
    `/billing/usage/daily?meter=${meter}&from=${encodeURIComponent(new Date(range.from.getTime() - DAY_MS).toISOString())}&to=${encodeURIComponent(range.to.toISOString())}`,
  );
  const series = dailyQ.data ? fillDays(dailyQ.data.days, range.fromDay, range.toDay) : [];
  const meters = status.usage?.meters ?? [];
  return (
    <SettingsCard title={tx("Usage", "الاستهلاك")}>
      <div style={{ display: "grid", gap: 12, fontSize: 13 }}>
        <div className="muted" style={{ fontSize: 12 }}>
          {tx("The last 30 days. Usage is measured, not charged.", "آخر 30 يومًا. يُقاس الاستهلاك ولا يُحتسب عليه.")}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
          {METERS.map((m) => {
            const row = meters.find((x) => x.meter === m);
            return (
              <button
                key={m}
                type="button"
                className="stat"
                aria-pressed={meter === m}
                onClick={() => setMeter(m)}
                style={{ textAlign: "start", cursor: "pointer", outline: meter === m ? "2px solid var(--accent)" : undefined }}
              >
                <div className="label">{tx(METER_COPY[m][0], METER_COPY[m][1])}</div>
                <div className="value" style={{ fontSize: 22 }}>
                  <bdi>{usageText(row?.used ?? 0, row?.allowance ?? null, lang)}</bdi>
                </div>
              </button>
            );
          })}
        </div>
        <DailyBars series={series} loading={dailyQ.loading && !dailyQ.data} tx={tx} lang={lang} label={tx(METER_COPY[meter][0], METER_COPY[meter][1])} />
      </div>
    </SettingsCard>
  );
}

/**
 * One series per meter: thin bars from the baseline, one hue (no legend; the
 * title names it), a native tooltip per bar with a hit area as tall as the
 * plot, and the same numbers as a table for screen readers and print.
 */
function DailyBars({ series, loading, tx, lang, label }: { series: { day: string; qty: number }[]; loading: boolean; tx: Tx; lang: Lang; label: string }) {
  if (loading) return <div className="muted" style={{ fontSize: 12 }}>{tx("Loading…", "جارٍ التحميل…")}</div>;
  if (series.length === 0) return null;
  const max = Math.max(1, ...series.map((s) => s.qty));
  const W = 600;
  const H = 120;
  const slot = W / series.length;
  const bar = Math.max(2, slot - 2);
  const total = series.reduce((a, s) => a + s.qty, 0);
  return (
    <figure style={{ margin: 0, display: "grid", gap: 6 }}>
      <figcaption style={{ fontSize: 12, fontWeight: 600 }}>
        {label} · {tx("per day", "يوميًا")} · <bdi>{formatCount(total)}</bdi>
      </figcaption>
      {total === 0 ? (
        <div className="muted" style={{ fontSize: 12 }}>{tx("No usage in this period.", "لا يوجد استهلاك في هذه الفترة.")}</div>
      ) : (
        // Time reads from the start edge: mirrored in RTL with the app's flip-rtl.
        <svg className="flip-rtl" viewBox={`0 0 ${W} ${H + 2}`} style={{ inlineSize: "100%", blockSize: 130 }} aria-hidden="true">
          <line x1={0} x2={W} y1={H} y2={H} stroke="var(--line)" strokeWidth={1} />
          {series.map((s, i) => {
            const h = s.qty === 0 ? 0 : Math.max(2, (s.qty / max) * (H - 8));
            return (
              <g key={s.day}>
                <rect x={i * slot} y={0} width={slot} height={H} fill="transparent">
                  <title>{`${shortDay(s.day, lang)}: ${formatCount(s.qty)}`}</title>
                </rect>
                {h > 0 && <rect x={i * slot + (slot - bar) / 2} y={H - h} width={bar} height={h} rx={Math.min(2, bar / 2)} fill="var(--accent)" pointerEvents="none" />}
              </g>
            );
          })}
        </svg>
      )}
      {total > 0 && (
        <div className="muted" style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
          <bdi>{shortDay(series[0].day, lang)}</bdi>
          <bdi>{shortDay(series[series.length - 1].day, lang)}</bdi>
        </div>
      )}
      <details>
        <summary style={{ fontSize: 12, cursor: "pointer" }}>{tx("Show as a table", "عرض كجدول")}</summary>
        <table className="tbl" style={{ inlineSize: "100%", fontSize: 12 }}>
          <thead>
            <tr>
              <th style={{ textAlign: "start" }}>{tx("Day", "اليوم")}</th>
              <th style={{ textAlign: "end" }}>{label}</th>
            </tr>
          </thead>
          <tbody>
            {series.map((s) => (
              <tr key={s.day}>
                <td>{shortDay(s.day, lang)}</td>
                <td className="mono" style={{ textAlign: "end" }}>
                  {formatCount(s.qty)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

function WalletCard({ status, tx, lang, tz }: { status: BillingStatus; tx: Tx; lang: Lang; tz: string | null | undefined }) {
  const first = useFetch<BillingLedgerPage>("/billing/wallet/ledger");
  const [more, setMore] = useState<BillingLedgerItem[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const items = [...(first.data?.items ?? []), ...more];
  const next = cursor === undefined ? first.data?.nextCursor ?? null : cursor;
  const loadMore = async () => {
    if (!next) return;
    setBusy(true);
    setError(null);
    try {
      const page = await api.get<BillingLedgerPage>(`/billing/wallet/ledger?cursor=${encodeURIComponent(next)}`);
      setMore((m) => [...m, ...page.items]);
      setCursor(page.nextCursor);
    } catch (e) {
      setError(billingErrorText(e, tx, lang));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsCard title={tx("Wallet", "المحفظة")}>
      <div style={{ display: "grid", gap: 10, fontSize: 13 }}>
        {status.wallet && (
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <span style={{ fontSize: 22, fontWeight: 600 }}>
              <bdi>{formatJod(status.wallet.balanceJod, lang)}</bdi>
            </span>
            {status.wallet.lowBalance && (
              <span className="badge warn">{Number(status.wallet.balanceJod) <= 0 ? tx("Empty", "فارغة") : tx("Low balance", "رصيد منخفض")}</span>
            )}
          </div>
        )}
        {items.length === 0 ? (
          <div className="muted" style={{ fontSize: 12 }}>
            {first.loading ? tx("Loading…", "جارٍ التحميل…") : tx("No wallet activity yet.", "لا توجد حركات في المحفظة بعد.")}
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="tbl" style={{ inlineSize: "100%", fontSize: 12.5 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "start" }}>{tx("Date", "التاريخ")}</th>
                  <th style={{ textAlign: "start" }}>{tx("Type", "النوع")}</th>
                  <th style={{ textAlign: "end" }}>{tx("Amount", "المبلغ")}</th>
                  <th style={{ textAlign: "end" }}>{tx("Balance", "الرصيد")}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <bdi>{dateTime(r.createdAt, tz, lang)}</bdi>
                    </td>
                    <td>
                      {ledgerTypeLabel(r.type, lang)}
                      {r.meter && <span className="muted"> · {tx(METER_COPY[r.meter][0], METER_COPY[r.meter][1])}</span>}
                    </td>
                    <td className="mono" style={{ textAlign: "end", color: Number(r.amountJod) < 0 ? "var(--ink-2)" : "var(--ok)" }}>
                      <bdi>{formatJod(r.amountJod, lang)}</bdi>
                    </td>
                    <td className="mono" style={{ textAlign: "end" }}>
                      <bdi>{formatJod(r.balanceAfterJod, lang)}</bdi>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {error && <div role="alert" style={{ color: "var(--bad)", fontSize: 12 }}>{error}</div>}
        {next && (
          <button type="button" className="btn sm" style={{ justifySelf: "start" }} disabled={busy} onClick={() => void loadMore()}>
            {busy ? tx("Loading…", "جارٍ التحميل…") : tx("Load more", "تحميل المزيد")}
          </button>
        )}
      </div>
    </SettingsCard>
  );
}
