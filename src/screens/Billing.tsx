import { memo, useState, type ReactNode } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/Badge";
import { Toggle } from "@/components/Toggle";
import { Bars } from "@/components/charts";
import {
  IconArrowUp,
  IconBolt,
  IconBook,
  IconCheck,
  IconMore,
  IconPlus,
} from "@/icons";
import {
  PLANS,
  INVOICES,
  USAGE,
  ADDONS,
  SPEND_BY_MONTH,
  SPEND_LABELS,
  type AddOn,
} from "@/data/billing-extras";

type BillingTab = "overview" | "plans" | "usage" | "invoices" | "payment";

interface RowProps {
  label: string;
  value: string;
}

function Row({ label, value }: RowProps) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        paddingBottom: 6,
        borderBottom: "1px solid var(--line-soft)",
      }}
    >
      <span
        className="mono"
        style={{
          fontSize: 11,
          color: "var(--ink-3)",
          textTransform: "uppercase",
          letterSpacing: 0.05,
        }}
      >
        {label}
      </span>
      <span style={{ color: "var(--ink-1)" }}>{value}</span>
    </div>
  );
}

function BillingImpl() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const isAr = t.lang === "ar";
  const [tab, setTab] = useState<BillingTab>("overview");
  const [addons, setAddons] = useState<AddOn[]>(ADDONS);
  const [autoTopup, setAutoTopup] = useState<boolean>(true);

  const usagePct = (used: number, limit: number) => Math.min(100, (used / limit) * 100);

  const toggleAddon = (idx: number) => {
    setAddons((prev) => prev.map((a, i) => (i === idx ? { ...a, on: !a.on } : a)));
  };

  return (
    <div
      style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" }}
    >
      <PageHeader
        title={tx("Billing & Subscription", "الفواتير والاشتراك")}
        subtitle={tx("Your plan, usage, and invoices", "خطتك، استخدامك، فواتيرك")}
        actions={
          <>
            <button className="btn ghost">
              <IconBook w={14} />
              {tx("Tax docs", "إيصالات ضريبية")}
            </button>
            <button className="btn primary">
              <IconBolt w={14} />
              {tx("Upgrade", "ترقية")}
            </button>
          </>
        }
      />

      <div className="tabs">
        <button
          className={`tab ${tab === "overview" ? "active" : ""}`.trim()}
          onClick={() => setTab("overview")}
        >
          {tx("Overview", "نظرة عامة")}
        </button>
        <button
          className={`tab ${tab === "plans" ? "active" : ""}`.trim()}
          onClick={() => setTab("plans")}
        >
          {tx("Plans", "الخطط")}
        </button>
        <button
          className={`tab ${tab === "usage" ? "active" : ""}`.trim()}
          onClick={() => setTab("usage")}
        >
          {tx("Usage", "الاستخدام")}
        </button>
        <button
          className={`tab ${tab === "invoices" ? "active" : ""}`.trim()}
          onClick={() => setTab("invoices")}
        >
          {tx("Invoices", "الفواتير")}
          <span className="count">{INVOICES.length}</span>
        </button>
        <button
          className={`tab ${tab === "payment" ? "active" : ""}`.trim()}
          onClick={() => setTab("payment")}
        >
          {tx("Payment", "طرق الدفع")}
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        {tab === "overview" && (
          <OverviewTab
            isAr={isAr}
            addons={addons}
            toggleAddon={toggleAddon}
          />
        )}
        {tab === "plans" && <PlansTab isAr={isAr} />}
        {tab === "usage" && (
          <UsageTab
            isAr={isAr}
            autoTopup={autoTopup}
            setAutoTopup={setAutoTopup}
            usagePct={usagePct}
          />
        )}
        {tab === "invoices" && <InvoicesTab isAr={isAr} />}
        {tab === "payment" && <PaymentTab isAr={isAr} />}
      </div>
    </div>
  );
}

interface OverviewTabProps {
  isAr: boolean;
  addons: AddOn[];
  toggleAddon: (i: number) => void;
}

function OverviewTab({ isAr, addons, toggleAddon }: OverviewTabProps): ReactNode {
  return (
    <div
      style={{
        padding: 20,
        display: "grid",
        gridTemplateColumns: "1.4fr 1fr",
        gap: 16,
      }}
    >
      {/* Current plan card */}
      <div className="card" style={{ padding: 20, position: "relative", overflow: "hidden" }}>
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "radial-gradient(circle at 100% 0%, var(--accent-soft), transparent 50%)",
            pointerEvents: "none",
          }}
        />
        <div style={{ position: "relative" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <Badge kind="ai" dot>
              {isAr ? "الخطة الحالية" : "Current plan"}
            </Badge>
            <Badge kind="ok">{isAr ? "تجديد تلقائي" : "Auto-renew"}</Badge>
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginTop: 12 }}>
            <h2
              style={{
                margin: 0,
                fontSize: 32,
                fontWeight: 600,
                letterSpacing: "-0.02em",
              }}
            >
              Pro
            </h2>
            <div className="mono" style={{ fontSize: 18, color: "var(--ink-2)" }}>
              $149<span style={{ fontSize: 13, color: "var(--ink-3)" }}>/mo</span>
            </div>
          </div>
          <p style={{ color: "var(--ink-2)", fontSize: 13, marginTop: 4 }}>
            {isAr ? "يتجدد في 1 يونيو 2026" : "Next renewal · June 1, 2026"}
          </p>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: 12,
              marginTop: 20,
            }}
          >
            <PlanMeter label={isAr ? "المحادثات" : "Conversations"} used="6,240" total="10,000" />
            <PlanMeter label={isAr ? "وكلاء" : "AI agents"} used="4" total="4" />
            <PlanMeter label={isAr ? "المقاعد" : "Seats"} used="7" total="10" />
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
            <button className="btn primary">
              <IconArrowUp w={13} />
              {isAr ? "ترقية إلى Scale" : "Upgrade to Scale"}
            </button>
            <button className="btn ghost">{isAr ? "إيقاف التجديد" : "Cancel renewal"}</button>
          </div>
        </div>
      </div>

      {/* This month spend */}
      <div className="card" style={{ padding: 20 }}>
        <div
          className="mono"
          style={{
            fontSize: 11,
            color: "var(--ink-3)",
            textTransform: "uppercase",
            letterSpacing: 0.06,
          }}
        >
          {isAr ? "هذا الشهر" : "This month"}
        </div>
        <div
          style={{
            fontSize: 32,
            fontWeight: 600,
            letterSpacing: "-0.02em",
            marginTop: 4,
          }}
        >
          $248.00
        </div>
        <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
          {isAr ? "$149 أساسي + $99 إضافات" : "$149 base + $99 add-ons"}
        </div>
        <div style={{ marginTop: 16 }}>
          <Bars values={SPEND_BY_MONTH} w={300} h={64} labels={SPEND_LABELS} />
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginTop: 16,
            fontSize: 12,
            color: "var(--ink-2)",
          }}
        >
          <span>{isAr ? "منذ بداية العام: $1,856" : "YTD: $1,856"}</span>
          <span style={{ color: "var(--ok)" }}>
            {isAr ? "↑ 14% مقارنة بالعام الماضي" : "↑ 14% vs prev. year"}
          </span>
        </div>
      </div>

      {/* Add-ons */}
      <div className="card" style={{ gridColumn: "1 / -1" }}>
        <div className="card-h">
          <h3>{isAr ? "الإضافات" : "Add-ons"}</h3>
          <div className="sub">
            {isAr ? "قدرات إضافية لمساحة عملك" : "extra capabilities for your workspace"}
          </div>
        </div>
        <div style={{ padding: 6 }}>
          {addons.map((a, i) => (
            <div
              key={a.name}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "12px 16px",
                borderBottom:
                  i < addons.length - 1 ? "1px solid var(--line-soft)" : "0",
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 500 }}>{a.name}</div>
                <div className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
                  ${a.price}
                  {a.unit}
                </div>
              </div>
              {a.on && (
                <Badge kind="ok" dot>
                  {isAr ? "مفعّل" : "active"}
                </Badge>
              )}
              <Toggle on={a.on} onChange={() => toggleAddon(i)} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function PlanMeter({
  label,
  used,
  total,
}: {
  label: string;
  used: string;
  total: string;
}) {
  return (
    <div>
      <div
        className="mono"
        style={{
          fontSize: 10,
          color: "var(--ink-3)",
          textTransform: "uppercase",
          letterSpacing: 0.06,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 600, marginTop: 2 }}>
        {used}
        <span style={{ color: "var(--ink-3)", fontSize: 13, fontWeight: 400 }}>
          {" "}
          / {total}
        </span>
      </div>
    </div>
  );
}

function PlansTab({ isAr }: { isAr: boolean }): ReactNode {
  return (
    <div
      style={{
        padding: 20,
        display: "grid",
        gridTemplateColumns: "repeat(4, 1fr)",
        gap: 12,
      }}
    >
      {PLANS.map((p) => (
        <div
          key={p.id}
          className="card"
          style={{
            padding: 20,
            position: "relative",
            border: p.current ? "1px solid var(--accent-ring)" : undefined,
            boxShadow: p.current ? "0 0 0 4px var(--accent-soft)" : undefined,
          }}
        >
          {p.current && (
            <Badge kind="ai" dot>
              {isAr ? "الحالية" : "current"}
            </Badge>
          )}
          <h3
            style={{
              marginTop: p.current ? 8 : 0,
              marginBottom: 4,
              fontSize: 18,
              fontWeight: 600,
            }}
          >
            {p.name}
          </h3>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 4,
              margin: "4px 0 16px",
            }}
          >
            {p.price !== null ? (
              <>
                <span
                  style={{ fontSize: 30, fontWeight: 600, letterSpacing: "-0.02em" }}
                >
                  ${p.price}
                </span>
                <span className="mono" style={{ fontSize: 12, color: "var(--ink-3)" }}>
                  {p.unit}
                </span>
              </>
            ) : (
              <span className="display" style={{ fontSize: 26 }}>
                {isAr ? "تواصل معنا" : "let's talk"}
              </span>
            )}
          </div>
          <div
            className="mono"
            style={{
              fontSize: 11,
              color: "var(--ink-3)",
              marginBottom: 12,
              padding: "8px 0",
              borderTop: "1px solid var(--line-soft)",
              borderBottom: "1px solid var(--line-soft)",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginBottom: 4,
              }}
            >
              <span>{isAr ? "المحادثات" : "Conversations"}</span>
              <span style={{ color: "var(--ink-1)" }}>{p.convs}</span>
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginBottom: 4,
              }}
            >
              <span>{isAr ? "وكلاء" : "AI agents"}</span>
              <span style={{ color: "var(--ink-1)" }}>{p.agents}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>{isAr ? "المقاعد" : "Seats"}</span>
              <span style={{ color: "var(--ink-1)" }}>{p.seats}</span>
            </div>
          </div>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {p.features.map((f) => (
              <li
                key={f}
                style={{ display: "flex", gap: 8, padding: "4px 0", fontSize: 13 }}
              >
                <span style={{ color: "var(--accent)" }}>
                  <IconCheck w={14} />
                </span>
                <span style={{ color: "var(--ink-1)" }}>{f}</span>
              </li>
            ))}
          </ul>
          <button
            className="btn"
            style={{ width: "100%", marginTop: 16, justifyContent: "center" }}
            disabled={p.current}
          >
            {p.current
              ? isAr
                ? "خطتك الحالية"
                : "Current plan"
              : p.price
                ? isAr
                  ? "اختر"
                  : "Choose plan"
                : isAr
                  ? "تواصل"
                  : "Contact sales"}
          </button>
        </div>
      ))}
    </div>
  );
}

interface UsageTabProps {
  isAr: boolean;
  autoTopup: boolean;
  setAutoTopup: (v: boolean) => void;
  usagePct: (used: number, limit: number) => number;
}

function UsageTab({ isAr, autoTopup, setAutoTopup, usagePct }: UsageTabProps): ReactNode {
  return (
    <div style={{ padding: 20, display: "grid", gap: 16, maxWidth: 900 }}>
      <div className="card">
        <div className="card-h">
          <h3>{isAr ? "الاستخدام لهذه الدورة" : "Current cycle usage"}</h3>
          <div className="sub">May 1 – May 31, 2026</div>
        </div>
        <div style={{ padding: 20 }}>
          {USAGE.map((u, i) => {
            const pct = usagePct(u.used, u.limit);
            const color =
              pct > 90 ? "var(--bad)" : pct > 75 ? "var(--warn)" : "var(--accent)";
            return (
              <div
                key={u.label}
                style={{ marginBottom: i < USAGE.length - 1 ? 18 : 0 }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "baseline",
                    marginBottom: 6,
                  }}
                >
                  <span style={{ fontWeight: 500 }}>{u.label}</span>
                  <span
                    className="mono"
                    style={{ fontSize: 12, color: "var(--ink-2)" }}
                  >
                    <span style={{ color: "var(--ink)" }}>
                      {u.used.toLocaleString()}
                      {u.unit}
                    </span>
                    <span style={{ color: "var(--ink-3)" }}>
                      {" "}
                      / {u.limit.toLocaleString()}
                      {u.unit}
                    </span>
                  </span>
                </div>
                <div
                  style={{
                    height: 6,
                    borderRadius: 3,
                    background: "var(--bg-3)",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: `${pct}%`,
                      height: "100%",
                      background: color,
                      transition: "width 0.3s",
                    }}
                  />
                </div>
                <div
                  className="mono"
                  style={{ fontSize: 10, color: "var(--ink-3)", marginTop: 4 }}
                >
                  {pct.toFixed(1)}% {isAr ? "مستخدم · يُعاد في 1 يونيو" : "used · resets Jun 1"}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="card" style={{ padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span
            style={{
              width: 36,
              height: 36,
              borderRadius: 8,
              background: "var(--accent-soft)",
              color: "var(--accent)",
              display: "grid",
              placeItems: "center",
            }}
          >
            <IconBolt w={18} />
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 500 }}>
              {isAr ? "حد الاستخدام التلقائي" : "Auto top-up"}
            </div>
            <div style={{ fontSize: 12, color: "var(--ink-2)" }}>
              {isAr
                ? "إضافة 1,000 محادثة تلقائيًا عند تجاوز 90% من الحد"
                : "Automatically add 1,000 conversations when usage hits 90%"}
            </div>
          </div>
          <Toggle on={autoTopup} onChange={setAutoTopup} />
        </div>
      </div>
    </div>
  );
}

function InvoicesTab({ isAr }: { isAr: boolean }): ReactNode {
  return (
    <div style={{ padding: 20 }}>
      <div className="card">
        <table className="tbl">
          <thead>
            <tr>
              <th>{isAr ? "الفاتورة" : "Invoice"}</th>
              <th>{isAr ? "الفترة" : "Period"}</th>
              <th>{isAr ? "التاريخ" : "Date"}</th>
              <th style={{ textAlign: "end" }}>{isAr ? "المبلغ" : "Amount"}</th>
              <th>{isAr ? "الحالة" : "Status"}</th>
              <th style={{ width: 120, textAlign: "end" }} />
            </tr>
          </thead>
          <tbody>
            {INVOICES.map((inv) => (
              <tr key={inv.id}>
                <td className="mono" style={{ fontWeight: 500, fontSize: 12 }}>
                  {inv.id}
                </td>
                <td style={{ color: "var(--ink-2)" }}>{inv.period}</td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {inv.date}
                </td>
                <td
                  className="mono"
                  style={{ textAlign: "end", fontWeight: 500 }}
                >
                  ${inv.amount.toFixed(2)}
                </td>
                <td>
                  <Badge kind="ok" dot>
                    {inv.status}
                  </Badge>
                </td>
                <td style={{ textAlign: "end" }}>
                  <button className="btn sm ghost">{isAr ? "عرض" : "View"}</button>
                  <button
                    className="btn sm ghost"
                    style={{ marginInlineStart: 4 }}
                  >
                    PDF
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PaymentTab({ isAr }: { isAr: boolean }): ReactNode {
  return (
    <div
      style={{
        padding: 20,
        display: "grid",
        gridTemplateColumns: "1fr 380px",
        gap: 16,
        maxWidth: 1100,
      }}
    >
      <div style={{ display: "grid", gap: 12 }}>
        {/* card */}
        <div
          className="card"
          style={{
            padding: 24,
            background:
              "linear-gradient(135deg, oklch(0.18 0.02 250), oklch(0.14 0.02 230))",
            color: "white",
            overflow: "hidden",
            position: "relative",
          }}
        >
          <div
            style={{
              position: "absolute",
              inset: 0,
              background:
                "radial-gradient(circle at 80% 100%, oklch(0.7 0.18 220 / 0.3), transparent 60%)",
            }}
          />
          <div style={{ position: "relative" }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                marginBottom: 32,
              }}
            >
              <Badge kind="ok" dot>
                {isAr ? "أساسية" : "primary"}
              </Badge>
              <span className="mono" style={{ fontSize: 11, opacity: 0.7 }}>
                VISA
              </span>
            </div>
            <div
              className="mono"
              style={{ fontSize: 18, letterSpacing: 4, marginBottom: 14 }}
            >
              •••• •••• •••• 4421
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                opacity: 0.8,
              }}
            >
              <div>
                <div style={{ opacity: 0.6, fontSize: 9 }}>CARDHOLDER</div>
                <div>YARA KHALED</div>
              </div>
              <div>
                <div style={{ opacity: 0.6, fontSize: 9 }}>EXPIRES</div>
                <div>09 / 28</div>
              </div>
            </div>
          </div>
        </div>

        <div
          className="card"
          style={{ padding: 16, display: "flex", alignItems: "center", gap: 12 }}
        >
          <span
            style={{
              width: 36,
              height: 36,
              borderRadius: 8,
              background: "var(--bg-2)",
              display: "grid",
              placeItems: "center",
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              border: "1px solid var(--line-soft)",
            }}
          >
            MC
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 500 }}>Mastercard •••• 8821</div>
            <div className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
              {isAr ? "تنتهي 03 / 27 · احتياطية" : "expires 03 / 27 · backup"}
            </div>
          </div>
          <button className="btn sm ghost">
            <IconMore w={14} />
          </button>
        </div>

        <button className="btn" style={{ alignSelf: "flex-start" }}>
          <IconPlus w={14} />
          {isAr ? "إضافة طريقة دفع" : "Add payment method"}
        </button>
      </div>

      <div className="card" style={{ padding: 18 }}>
        <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>
          {isAr ? "تفاصيل الفوترة" : "Billing details"}
        </h3>
        <p style={{ margin: "0 0 14px", color: "var(--ink-3)", fontSize: 12 }}>
          {isAr ? "تظهر على الفواتير الضريبية" : "Appears on tax invoices"}
        </p>
        <div style={{ display: "grid", gap: 10, fontSize: 13 }}>
          <Row label="Company" value="Samemha LLC" />
          <Row label="Tax ID" value="3001-22-8841 (VAT)" />
          <Row label="Country" value="Saudi Arabia" />
          <Row label="Address" value="King Fahd Rd, Olaya, Riyadh 12211" />
          <Row label="Email" value="finance@samemha.com" />
        </div>
        <button className="btn sm ghost" style={{ marginTop: 14 }}>
          {isAr ? "تعديل" : "Edit details"}
        </button>
      </div>
    </div>
  );
}

const Billing = memo(BillingImpl);
export default Billing;
